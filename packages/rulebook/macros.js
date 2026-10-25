// Rulebook macros: named CEL expressions, defined in macro files that rulebooks import. This
// module reads and resolves the imports; the loader expands each call where it's written, so
// every check a rulebook expression gets applies to the expansion (load.js).
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import { ParseError } from '@marcbachmann/cel-js';
import { YAMLError, parse as parseYaml } from 'yaml';
import { keyPathPlace, schemaMessage } from './schema-message.js';
import { childNodesOf, nodesOf } from './syntax-tree.js';

const schema = JSON.parse(readFileSync(new URL('./macros.schema.json', import.meta.url), 'utf-8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

const noBaseDir = (what) => `imports: a ${what} read from text resolves its imports from a folder; pass { baseDir }`;

// The macros a rulebook can call, and every problem its imports have. Each file is read once,
// however many files import it. A file sees its own macros and those of the files it imports
// directly, and so does the rulebook: a name it calls is in a file it names itself.
// `failure`, when not null, says why a call to a name nothing defines may be to a macro that didn't load.
export function readImports(imports, baseDir) {
  if (imports === undefined) return { visible: new Map(), all: [], errors: [], failure: null };
  if (baseDir === undefined) return { visible: new Map(), all: [], errors: [noBaseDir('rulebook')], failure: IMPORT_FAILED };
  const files = new Map();
  const errors = [];
  readImportedFiles(imports, baseDir, { files, errors, chain: [] });
  const read = everyMacroIn(files, errors);
  return { visible: visibleThrough(imports, baseDir, files), ...read, failure: read.errors.length > 0 ? IMPORT_FAILED : null };
}

const IMPORT_FAILED = 'an import above has a problem';
const MACRO_FAILED = 'a macro above has a problem';

// A macro file given as text, to be checked on its own (since 0.3): `visible` is its own macros, `all`
// those and its imports'. Its own macros and problems carry no file name (the caller knows the file);
// `path`, when the caller has one, lets an import that leads back to the file read as a cycle. Without
// `baseDir`, its imports aren't read, and its own macros are still checked.
export function readMacroText(text, baseDir, path) {
  const errors = [];
  const record = parseMacroFile(text, null, errors);
  if (record === null) return { visible: new Map(), all: [], errors, failure: MACRO_FAILED };
  const ownErrorCount = errors.length;
  const canImport = baseDir !== undefined;
  if (record.imports.length > 0 && !canImport) errors.push(noBaseDir('macro file'));
  const imports = canImport ? record.imports : [];
  const root = path === undefined ? Symbol('this file') : resolve(path);
  const files = new Map([[root, { ...record, importedFiles: imports.map((importPath) => resolve(baseDir, importPath)) }]]);
  readImportedFiles(imports, baseDir, { files, errors, chain: path === undefined ? [] : [root] });
  visibleThrough([], baseDir, files);
  const read = everyMacroIn(files, errors);
  const failure = read.errors.length > ownErrorCount ? IMPORT_FAILED : ownErrorCount > 0 ? MACRO_FAILED : null;
  return { visible: record.macros, ...read, failure };
}

// Reads each imported file into `files` (by path), and the files it imports, reporting what can't be read and
// any cycle in `errors`. `chain` is the files whose imports are being read, outermost first.
function readImportedFiles(imports, baseDir, { files, errors, chain }) {
  const placeOf = (path) => relative(baseDir, path).split(sep).join('/');
  const visit = (importer, paths, fromDir, chain) => {
    for (const path of paths) {
      const file = resolve(fromDir, path);
      if (chain.includes(file)) {
        errors.push(`imports form a cycle: ${[...chain.slice(chain.indexOf(file)), file].map(placeOf).join(' -> ')}`);
        continue;
      }
      if (!files.has(file)) {
        files.set(file, readMacroFile(file, placeOf(file), `${importer}"${path}"`, errors));
        visit(`${placeOf(file)} imports `, files.get(file)?.imports ?? [], dirname(file), [...chain, file]);
      }
    }
  };
  visit('imports ', imports, baseDir, chain);
}

function everyMacroIn(files, errors) {
  const readFiles = [...files.values()].filter(Boolean);
  errors.push(...duplicateErrors(readFiles));
  return { all: readFiles.flatMap((record) => [...record.macros.values()]), errors: [...new Set(errors)] };
}

// One macro file, or null when it can't be read or isn't a macro file (its problems are in `errors`).
function readMacroFile(file, place, importedAs, errors) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    errors.push(`${importedAs}: ${error.code === 'ENOENT' ? 'no such file' : `cannot read (${error.code ?? error.message})`}`);
    return null;
  }
  const record = parseMacroFile(text, place, errors);
  return record && { ...record, importedFiles: record.imports.map((path) => resolve(dirname(file), path)) };
}

// A macro file's text, read and checked against its schema; its problems are prefixed with `place`, unless
// that is null (a file given as text, whose caller names it).
function parseMacroFile(text, place, errors) {
  const prefix = place === null ? '' : `${place}: `;
  let document;
  try {
    document = parseYaml(text);
  } catch (error) {
    // The yaml package throws a ReferenceError for an alias that doesn't resolve (load.js).
    if (!(error instanceof YAMLError || error instanceof ReferenceError)) throw error;
    errors.push(`${prefix}YAML: ${error.message.split('\n')[0]}`);
    return null;
  }
  const invalidNames = new Set();
  if (!validateSchema(document)) {
    const schemaErrors = validateSchema.errors.filter((error) => error.keyword !== 'propertyNames');
    errors.push(...new Set(schemaErrors.map((error) => `${prefix}${schemaMessage(error, keyPathPlace, 'macro')}`)));
    // A problem in one macro's entry leaves the file's other macros usable; any other problem, the whole file.
    const macroNames = schemaErrors.map(macroNameOf);
    if (macroNames.includes(null)) return null;
    for (const name of macroNames) invalidNames.add(name);
  }
  const macros = new Map(Object.entries(document.macros).filter(([name]) => !invalidNames.has(name))
    .map(([name, { params = [], body, description = null }]) => [name, { name, params, body, description, file: place }]));
  return { place, macros, imports: document.imports ?? [] };
}

// The macro a schema problem is in (`/macros/<name>/…`, or a name the pattern refuses), or null.
function macroNameOf(error) {
  if (error.instancePath === '/macros' && error.propertyName !== undefined) return error.propertyName;
  const [, top, name] = error.instancePath.split('/');
  return top === 'macros' && name !== undefined ? name.replaceAll('~1', '/').replaceAll('~0', '~') : null;
}

// A name means one thing wherever it's imported.
function duplicateErrors(files) {
  const firstFileOf = new Map();
  return files.flatMap(({ place, macros }) => [...macros.keys()].flatMap((name) => {
    if (!firstFileOf.has(name)) {
      firstFileOf.set(name, place);
      return [];
    }
    return [`macro "${name}" is defined in both ${firstFileOf.get(name) ?? 'this file'} and ${place}`];
  }));
}

// ---------------------------------------------------------------------------------------------
// Expansion. A call `name(a, b)` becomes `(body)`, each param in the body replaced by `(argument)`,
// so precedence is kept wherever the call sits. A CEL list macro's variable (`exists(x, …)`) or
// cel.bind's hides a param of the same name, and an argument that reads a name the body binds
// would be captured by it, so that is refused.

// A body reads its params, and these: the working set, the receivers of BelayKit's helpers and of
// cel.bind, and the type names cel-js predefines (`type(x) == string`).
const ALWAYS_READABLE = new Set(['ws', 'belaykit', 'cel', 'string', 'int', 'uint', 'bool', 'double', 'bytes', 'list', 'map', 'type', 'null_type', 'google']);
// CEL's list macros bind their first argument in the rest (cel-js, lib/macros.js).
const COMPREHENSIONS = new Set(['all', 'exists', 'exists_one', 'map', 'filter']);
// Larger than this, an expansion is refused rather than checked: a few macros that each call the
// last twice double it every time, past what cel-js parses (100,000 nodes) or a string can hold.
const MAX_EXPANSION = 100_000;

export const labelOf = (macro) => (macro.file === null ? `macro "${macro.name}"` : `macro "${macro.name}" (${macro.file})`);

// Spliced text is grouped with its closing parenthesis on a line of its own, so a `//` comment at
// the end of a body or an argument can't swallow it.
const grouped = (text) => `(${text}\n)`;

// `name(…)`, or `x.name(…)`, which is refused: a macro is called by name alone. A method on
// `belaykit` is a helper, never a macro.
const isMacroCall = (node, scope) => node.op === 'call' && scope.has(node.args[0]);
const isMethodMacroCall = (node, scope) => node.op === 'rcall' && scope.has(node.args[0])
  && !(node.args[1]?.op === 'id' && node.args[1].args === 'belaykit');
const isAnyMacroCall = (node, scope) => isMacroCall(node, scope) || isMethodMacroCall(node, scope);
const argumentsOf = (node) => (node.op === 'call' ? node.args[1] : [node.args[1], ...node.args[2]]);

const isCelBind = (node) => node.args[0] === 'bind' && node.args[1]?.op === 'id' && node.args[1].args === 'cel';

// Each identifier in an expression, with the names bound where it is.
function forEachId(node, onId, bound = new Set()) {
  if (node.op === 'id') {
    onId(node, bound);
    return;
  }
  if (node.op === 'rcall') {
    const [name, receiver, args] = node.args;
    const variable = args[0]?.op === 'id' ? args[0].args : null;
    if (variable !== null && isCelBind(node)) {
      if (args[1]) forEachId(args[1], onId, bound);
      for (const argument of args.slice(2)) forEachId(argument, onId, new Set(bound).add(variable));
      return;
    }
    if (variable !== null && COMPREHENSIONS.has(name)) {
      forEachId(receiver, onId, bound);
      for (const argument of args.slice(1)) forEachId(argument, onId, new Set(bound).add(variable));
      return;
    }
  }
  for (const child of childNodesOf(node.args)) forEachId(child, onId, bound);
}

function freeNamesOf(ast) {
  const names = new Set();
  forEachId(ast, (node, bound) => {
    if (!bound.has(node.args)) names.add(node.args);
  });
  return names;
}

// The whole of `source`, each macro call in it replaced by replaceCall(macro, call, argumentTexts),
// its arguments rewritten first.
const rewriteCalls = (source, ast, scope, replaceCall) => rewriteRange(source, { start: 0, end: source.length }, ast, scope, replaceCall);

// A node's span ends with its last child, so it leaves out a closing parenthesis that groups that
// child (`a && (b)` spans `a && (b`); a call's span is exact. So text is spliced from ranges a call
// gives: the whole expression, and each argument between the call's own parentheses and commas.
function rewriteRange(source, range, node, scope, replaceCall) {
  if (isAnyMacroCall(node, scope)) return rewriteCall(source, node, scope, replaceCall);
  let text = '';
  let at = range.start;
  for (const call of outermostCallsIn(node, scope)) {
    text += source.slice(at, call.start) + rewriteCall(source, call, scope, replaceCall);
    at = call.end;
  }
  return text + source.slice(at, range.end);
}

function rewriteCall(source, call, scope, replaceCall) {
  const macro = scope.get(call.args[0]);
  if (call.op === 'rcall') return replaceCall(macro, call, null); // refused; its receiver isn't one of its params
  const argumentTexts = argumentRangesOf(source, call)
    .map((range, index) => rewriteRange(source, range, call.args[1][index], scope, replaceCall));
  return replaceCall(macro, call, argumentTexts);
}

// `name(a, (b))`: each argument from after the opening parenthesis or a comma to the next comma or
// the closing one. Between one argument's end and the next's start there is only what its span left
// out (closing parentheses, space, `//` comments) and the comma.
function argumentRangesOf(source, call) {
  const argumentNodes = call.args[1];
  const open = source.indexOf('(', call.start);
  const separators = argumentNodes.slice(0, -1).map((argument) => separatorAfter(source, argument.end));
  return argumentNodes.map((argument, index) => ({
    start: index === 0 ? open + 1 : separators[index - 1] + 1,
    end: index === argumentNodes.length - 1 ? call.end - 1 : separators[index],
  }));
}

function separatorAfter(source, from) {
  let at = from;
  while (source[at] !== ',') {
    if (source.startsWith('//', at)) {
      const lineEnd = source.indexOf('\n', at);
      at = lineEnd === -1 ? source.length : lineEnd;
    } else {
      at += 1;
    }
  }
  return at;
}

const outermostCallsIn = (node, scope) => childNodesOf(node.args)
  .flatMap((child) => (isAnyMacroCall(child, scope) ? [child] : outermostCallsIn(child, scope)))
  .sort((first, second) => first.start - second.start);

// The body with each free param replaced by its argument, and the names an argument reads that
// the body binds where it lands (each would be captured).
function substitute(parse, body, params, argumentTexts) {
  if (params.length === 0) return { text: body, captures: [] };
  const argumentOf = new Map(params.map((param, index) => [param, argumentTexts[index]]));
  const namesRead = new Map(params.map((param, index) => [param, freeNamesOf(parse(argumentTexts[index]))]));
  const replaced = [];
  const captures = new Set();
  forEachId(parse(body), (node, bound) => {
    if (bound.has(node.args) || !argumentOf.has(node.args)) return;
    replaced.push(node);
    for (const name of namesRead.get(node.args)) if (bound.has(name)) captures.add(name);
  });
  replaced.sort((first, second) => first.start - second.start);
  let text = '';
  let at = 0;
  for (const node of replaced) {
    text += `${body.slice(at, node.start)}${grouped(argumentOf.get(node.args))}`;
    at = node.end;
  }
  return { text: text + body.slice(at), captures: [...captures] };
}

// An expansion past MAX_EXPANSION, or one cel-js refuses to parse for its size: a problem, not a crash.
class ExpansionTooLarge extends Error {}

const TOO_LARGE = `expands to more than ${MAX_EXPANSION.toLocaleString('en-US')} characters, too large to check; call fewer macros that call macros`;

function parseExpansion(parse, text) {
  if (text.length > MAX_EXPANSION) throw new ExpansionTooLarge();
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof ParseError && /maxAstNodes/.test(error.message)) throw new ExpansionTooLarge();
    throw error;
  }
}

// Expands calls, each macro's body once. A body too large to expand stays so: it throws every time,
// without being expanded again.
function makeExpander(parse) {
  const bodies = new Map();
  const expandedBody = (macro) => {
    if (!bodies.has(macro)) {
      bodies.set(macro, null);
      const captures = [];
      const text = rewriteCalls(macro.body, parse(macro.body), macro.scope, (callee, call, argumentTexts) => {
        const expansion = expandCall(callee, argumentTexts);
        captures.push(...expansion.captures.map((name) => captureProblem(callee, name)));
        return expansion.text;
      });
      if (text.length > MAX_EXPANSION) throw new ExpansionTooLarge();
      bodies.set(macro, { text, captures });
    }
    if (bodies.get(macro) === null) throw new ExpansionTooLarge();
    return bodies.get(macro);
  };
  function expandCall(macro, argumentTexts) {
    const { text, captures } = substitute((source) => parseExpansion(parse, source), expandedBody(macro).text, macro.params, argumentTexts);
    if (text.length > MAX_EXPANSION) throw new ExpansionTooLarge();
    return { text: grouped(text), captures };
  }
  return { expandCall, expandedBody };
}

const arityProblem = (macro, given) => `macro "${macro.name}" takes ${macro.params.length === 0 ? 'no arguments'
  : `${macro.params.length} argument${macro.params.length === 1 ? '' : 's'} (${macro.params.join(', ')})`}, given ${given}`;
const methodCallProblem = (name) => `macro "${name}" is called as a method; call it as ${name}(…)`;
const captureProblem = (macro, name) => `macro "${macro.name}": an argument reads "${name}", which the macro's body binds too; rename that variable in the macro`;

// Every macro the rulebook imports, checked on its own, once, whether or not it's called: its
// name, its params, the names its body reads, the calls it makes, cycles, and captures. Returns the
// problems, `isExpandable` (false for a macro with a problem or one that reaches one: it is never
// expanded, so its callers aren't either), and the expander.
export function checkMacroDefinitions(macros, { parse, nameProblem, paramProblem }) {
  const problems = [];
  const broken = new Set();
  const report = (macro, message) => {
    problems.push(`${labelOf(macro)}: ${message}`);
    broken.add(macro);
  };
  // A refused name isn't a macro anywhere, so a call by that name stays the CEL or registered function's.
  const refused = new Set(macros.filter((macro) => nameProblem(macro.name)).map(({ name }) => name));
  for (const macro of macros) for (const name of refused) macro.scope.delete(name);
  const calleesOf = new Map();
  for (const macro of macros) {
    const nameIssue = nameProblem(macro.name);
    if (nameIssue) report(macro, `the name ${nameIssue}`);
    const refusedParams = new Set();
    for (const param of macro.params) {
      const issue = paramProblem(param);
      if (issue) report(macro, `param "${param}" ${issue}`);
      if (issue) refusedParams.add(param);
    }
    let ast;
    try {
      ast = parse(macro.body);
    } catch (error) {
      report(macro, error.message.split('\n')[0]);
      continue;
    }
    for (const problem of bodyProblems(macro, ast, refusedParams)) report(macro, problem);
    calleesOf.set(macro, new Set([...nodesOf(ast)].filter((node) => isMacroCall(node, macro.scope)).map((node) => macro.scope.get(node.args[0]))));
  }
  for (const cycle of cyclesIn(calleesOf)) report(cycle[0], `calls itself: ${cycle.map(({ name }) => name).join(' -> ')}`);
  const reachedFrom = (called) => reachableFrom(called, calleesOf);
  const isExpandable = (macro) => !broken.has(macro) && [...reachedFrom([macro])].every((reached) => !broken.has(reached));
  const expander = makeExpander(parse);
  // Checked one at a time, so a macro that calls one already refused (too large, say) is skipped, not reported again.
  for (const macro of macros) {
    if (!isExpandable(macro)) continue;
    try {
      for (const capture of expander.expandedBody(macro).captures) report(macro, capture);
    } catch (error) {
      if (!(error instanceof ExpansionTooLarge)) throw error;
      report(macro, TOO_LARGE);
    }
  }
  return { problems, isExpandable, expander, refused };
}

// What a body reads and calls: only its params (and ws), every param, and macros by name with as
// many arguments as they take. A refused param isn't also reported as unused.
function bodyProblems(macro, ast, refusedParams) {
  const free = freeNamesOf(ast);
  const params = macro.params.length ? macro.params.join(', ') : 'it has none';
  return [
    ...[...free].filter((name) => !macro.params.includes(name) && !ALWAYS_READABLE.has(name))
      .map((name) => `reads "${name}", which is neither ws nor one of its params (${params})`),
    ...macro.params.filter((param) => !free.has(param) && !refusedParams.has(param)).map((param) => `param "${param}" is never used`),
    ...[...nodesOf(ast)].flatMap((node) => {
      if (isMethodMacroCall(node, macro.scope)) return [methodCallProblem(node.args[0])];
      if (!isMacroCall(node, macro.scope)) return [];
      const callee = macro.scope.get(node.args[0]);
      return argumentsOf(node).length === callee.params.length ? [] : [arityProblem(callee, argumentsOf(node).length)];
    }),
  ];
}

// Each cycle once, from the macro it is first found at.
function cyclesIn(calleesOf) {
  const cycles = [];
  const done = new Set();
  const visit = (macro, chain) => {
    if (chain.includes(macro)) {
      cycles.push([...chain.slice(chain.indexOf(macro)), macro]);
      return;
    }
    if (done.has(macro)) return;
    for (const callee of calleesOf.get(macro) ?? []) visit(callee, [...chain, macro]);
    done.add(macro);
  };
  for (const macro of calleesOf.keys()) visit(macro, []);
  return cycles;
}

function reachableFrom(macros, calleesOf) {
  const reached = new Set();
  const visit = (macro) => {
    if (reached.has(macro)) return;
    reached.add(macro);
    for (const callee of calleesOf.get(macro) ?? []) visit(callee);
  };
  for (const macro of macros) visit(macro);
  return reached;
}

// One expression that may call macros, rewritten twice: with each call replaced by a stand-in
// that keeps its arguments (`dyn([dyn(a), dyn(b)])`), so the expression's own text is checked
// alone; and expanded. Null when it calls no macro. `expanded` is null when it can't be expanded:
// a call is malformed, or reaches a broken macro.
export function macroSite(source, { parse, scope, macroCheck }) {
  if (scope.size === 0) return null;
  let ast;
  try {
    ast = parse(source);
  } catch {
    return null; // the expression's own check reports the syntax error
  }
  const calls = [...nodesOf(ast)].filter((node) => isAnyMacroCall(node, scope));
  if (calls.length === 0) return null;
  const problems = calls.flatMap((call) => {
    if (call.op === 'rcall') return [methodCallProblem(call.args[0])];
    const macro = scope.get(call.args[0]);
    return argumentsOf(call).length === macro.params.length ? [] : [arityProblem(macro, argumentsOf(call).length)];
  });
  // A call that is itself wrong, or to a macro that can't be expanded, stands in even in the expansion, so the
  // expression's other calls are still expanded and checked: one bad call hides nothing else.
  const isExpandableCall = (macro, call) => call.op === 'call' && argumentsOf(call).length === macro.params.length
    && macroCheck.isExpandable(macro);
  const called = [...new Set(calls.filter((call) => isExpandableCall(scope.get(call.args[0]), call)).map((call) => scope.get(call.args[0])))];
  const standInFor = (macro, call, argumentTexts) => (argumentTexts?.length
    ? `dyn([${argumentTexts.map((text) => `dyn${grouped(text)}`).join(', ')}])` : 'dyn(null)');
  const standIn = rewriteCalls(source, ast, scope, standInFor);
  if (called.length === 0) return { problems, standIn, expanded: null, called };
  const captures = [];
  // `only`: the one macro expanded, every other call standing in, so a problem is named by its macro.
  const expandedWith = (only) => rewriteCalls(source, ast, scope, (macro, call, argumentTexts) => {
    if (!isExpandableCall(macro, call) || (only && macro !== only)) return standInFor(macro, call, argumentTexts);
    const expansion = macroCheck.expander.expandCall(macro, argumentTexts);
    captures.push(...expansion.captures.map((name) => captureProblem(macro, name)));
    return expansion.text;
  });
  let expanded;
  try {
    expanded = expandedWith(null);
    if (expanded.length > MAX_EXPANSION) throw new ExpansionTooLarge();
  } catch (error) {
    if (!(error instanceof ExpansionTooLarge)) throw error;
    return { problems: [...problems, `the expansion ${TOO_LARGE}`], standIn, expanded: null, called };
  }
  if (captures.length > 0) return { problems: [...problems, ...new Set(captures)], standIn, expanded: null, called };
  return { problems, standIn, expanded, called, expandedWith };
}

// What the rulebook can call: the macros of the files it imports directly. Each macro carries
// what its own body can call: its file's macros and those of the files that file imports.
function visibleThrough(imports, baseDir, files) {
  const macrosOf = (paths) => new Map(paths.flatMap((file) => [...(files.get(file)?.macros.values() ?? [])].map((macro) => [macro.name, macro])));
  for (const record of files.values()) {
    if (!record) continue;
    const scope = new Map([...macrosOf(record.importedFiles), ...record.macros]);
    for (const macro of record.macros.values()) macro.scope = scope;
  }
  return macrosOf(imports.map((path) => resolve(baseDir, path)));
}
