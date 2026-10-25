// Loads a BelayKit rulebook (YAML + CEL) and rejects every static problem
// before anything runs: schema, badly named or unregistrable functions,
// unregistered producers and actions, CEL that fails to compile, predicates of a
// known non-boolean type, rules sharing an explicit id, ws fields nothing declares
// (read from the syntax tree, including keys passed to helpers), `matches`
// patterns that aren't safe literals, any use of the name reserved for
// BelayKit's own helpers (`belaykit`, helpers.js), and a helper's path that isn't a
// literal or names a field nothing declares.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import { Environment } from '@marcbachmann/cel-js';
import isSafeRegex from 'safe-regex2';
import { YAMLError, parse as parseYaml } from 'yaml';
import { EMPTY_SEGMENT, HELPER_NAMES, NAMESPACE, NAMESPACE_TYPE, helperPathCallOf, pathProblem, registerHelpers } from './helpers.js';
import { checkMacroDefinitions, labelOf, macroSite, readImports, readMacroText } from './macros.js';
import { compileParamsCheckers, compileTemplatedParams, paramsProblems } from './params.js';
import { keyPathPlace, schemaMessage } from './schema-message.js';
import { nodesOf } from './syntax-tree.js';
import { bindingFor, compileShapes, shapeErrors } from './shapes.js';
import { hasPlaceholderSyntax, parseTemplate } from './templates.js';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

// The plugin maintains no field of its own: every key, a terminal field included, is the
// agent's to declare. A field it once maintained is named with what replaced it.
const RETIRED_FIELDS = { gathered: 'gone in 0.2: test has(ws.<key>) for a gathered key' };
const PREDICATE = { name: 'bool', accepts: (type) => type === 'bool' || type === 'dyn' };
const LIST = { name: 'list', accepts: (type) => type === 'dyn' || type.startsWith('list') };
// A macro's body may be of any type; where it's called decides what it must be.
const ANY = { name: 'any', accepts: () => true };
// A placeholder becomes text: a known type must be one that renders as text (provider.js).
// cel-js's uint is an object (`UnsignedInt`), not a number, so it isn't text.
const TEXT = { name: 'text (a string, number or boolean)', accepts: (type) => ['string', 'int', 'double', 'bool', 'dyn'].includes(type) };
// cel-js accepts these as variable names, but `true` then reads as the literal and `in`
// can't be parsed, so a binding may not use them (CEL's reserved words).
const CEL_RESERVED_WORDS = new Set([
  'true', 'false', 'null', 'in', 'as', 'break', 'const', 'continue', 'else', 'for', 'function', 'if', 'import', 'let',
  'loop', 'package', 'namespace', 'return', 'var', 'void', 'while',
]);
const FUNCTION_NAME = /^[a-z][a-zA-Z0-9_]*$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const REGISTRY_KEYS = ['producers', 'actions', 'functions', 'version', 'initialKeys', 'shapes'];
const PRODUCER_KEYS = ['writes', 'run'];
const ACTION_KEYS = ['writes', 'params', 'templates', 'guard', 'run'];
// cel-js expands these itself, so they aren't among its function definitions.
const CEL_MACROS = ['has', 'all', 'exists', 'exists_one', 'map', 'filter'];
const RESERVED = 'is reserved for BelayKit\'s helpers';

// A rulebook's imports resolve from its own folder.
export function loadRulebook(path, registry) {
  return loadRulebookText(readFileSync(path, 'utf-8'), registry, { baseDir: dirname(resolve(path)) });
}

// Every problem in a rulebook, one string each; [] when it's clean. A problem in the
// file is returned, never thrown; a broken registry still throws.
export function checkRulebook(text, registry, options) {
  try {
    loadRulebookText(text, registry, options);
    return [];
  } catch (error) {
    if (error instanceof RulebookError) return error.problems;
    throw error;
  }
}

// A macro file checked alone has no needs keys, so it knows the keys its registry names anywhere (since 0.3).
const MACRO_FILE_GIVEN = 'this is a macro file (macros:, no sections:); check it with Rulebook.checkMacros or belaykit-rulebook check';
const MACRO_FILE_KEY_HINT = ' (a macro file knows the keys its registry names: initialKeys, writes and shapes)';
const RULEBOOK_GIVEN = 'this is a rulebook (sections:); check it with Rulebook.check or belaykit-rulebook check';

// Every problem in a macro file, each of its macros checked as a rulebook calling it would check it, whether
// or not one does (since 0.3); [] when it's clean. `path`, the command's, lets an import back to the file read
// as a cycle.
export function checkMacroText(text, registry, { baseDir, path } = {}) {
  const imported = readMacroText(text, baseDir, path);
  const checks = prepareChecks(registry, { imported, knownKeys: shapeKeysOf(registry), unknownKeyHint: MACRO_FILE_KEY_HINT });
  for (const macro of imported.visible.values()) {
    if (checks.macroCheck.isExpandable(macro)) checks.bodyProblemsOf(macro);
  }
  const hint = isRulebookFile(parseYamlOrNull(text)) ? [RULEBOOK_GIVEN] : [];
  return [...unresolvedErrors(checks.errors, checks.failure), ...hint];
}

// A rulebook or a macro file, told apart by content: a macro file has macros and no sections. Text that
// isn't YAML is a rulebook's to report, as before 0.3.
export function checkText(text, registry, options) {
  return isMacroFile(parseYamlOrNull(text)) ? checkMacroText(text, registry, options) : checkRulebook(text, registry, options);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isMacroFile = (document) => isPlainObject(document) && Object.hasOwn(document, 'macros') && !Object.hasOwn(document, 'sections');
const isRulebookFile = (document) => isPlainObject(document) && Object.hasOwn(document, 'sections');
const shapeKeysOf = (registry) => (isPlainObject(registry.shapes) ? Object.keys(registry.shapes) : []);

function parseYamlOrNull(text) {
  try {
    return parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLError || error instanceof ReferenceError) return null; // the rulebook check reports it
    throw error;
  }
}

// Thrown by the loader for problems in the file; its message lists them, one per line.
class RulebookError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

// The yaml package throws a YAMLError for bad syntax, and a ReferenceError for an alias
// that doesn't resolve or expands too far; both are problems in the text.
function parseRulebookYaml(text) {
  try {
    return parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLError || error instanceof ReferenceError) throw new RulebookError([`YAML: ${error.message.split('\n')[0]}`]);
    throw error;
  }
}

// `baseDir` is where the rulebook's imports resolve from: its own folder.
export function loadRulebookText(text, registry, { baseDir } = {}) {
  const document = parseRulebookYaml(text);
  if (!validateSchema(document)) {
    // A bad property name comes as two errors: the name's own (kept) and a generic one.
    const errors = validateSchema.errors.filter((error) => error.keyword !== 'propertyNames');
    const hint = isMacroFile(document) ? [MACRO_FILE_GIVEN] : [];
    throw new RulebookError([...new Set(errors.map((error) => schemaMessage(error, (path) => rulebookPlace(document, path)))), ...hint]);
  }
  const declaredKeys = [...new Set(document.sections.flatMap((section) => Object.keys(section.needs ?? {})))];
  const checks = prepareChecks(registry, { imported: readImports(document.imports, baseDir), knownKeys: declaredKeys });
  const { env, shapes, errors, compile, paramsCheckers, templated, isBraceCheckable, actionGuards } = checks;
  const expand = (owner, expression, options) => checks.expandIn(checks.callable)(owner, expression, options).text;

  const sections = document.sections.map((section) => {
    const label = `section "${section.name}"`;
    for (const [key, producer] of Object.entries(section.needs ?? {})) {
      if (key in Object.prototype) errors.push(`${label} needs "${key}": that name is a property of every JavaScript object; use another`);
      if (!Object.hasOwn(registry.producers, producer)) errors.push(`${label} needs "${key}": unknown producer "${producer}"`);
    }
    const rules = (section.rules ?? []).map((rule, index) => {
      // A rule is named by position, plus its explicit id when it has one, so an error
      // at load matches the name the rule has at run time.
      const ruleLabel = `${label} rule ${index + 1}${rule.id ? ` (${rule.id})` : ''}`;
      const { action, ...params } = rule.then;
      if (!Object.hasOwn(registry.actions, action)) {
        errors.push(`${ruleLabel}: unknown action "${action}"`);
      } else {
        errors.push(...paramsProblems(action, params, paramsCheckers).map((problem) => `${ruleLabel}: ${problem}`));
      }
      const selectFirst = rule.selectFirst ? compileSelection(ruleLabel, rule.selectFirst, { env, registry, compile: expand, errors }) : null;
      const bindings = selectFirst ? new Map([[selectFirst.name, selectionBinding(selectFirst, shapes)]]) : undefined;
      // Each placeholder's expansion, by its text as written; the provider fills params from the template.
      const placeholders = new Map();
      if (Object.hasOwn(registry.actions, action)) {
        const templatedParams = templated.get(action) ?? new Set();
        errors.push(...templateErrors(ruleLabel, action, params, templatedParams, {
          checkBraces: (param) => isBraceCheckable(action, param),
          compilePlaceholder: (owner, expression) => placeholders.set(expression, expand(owner, expression, { environment: selectFirst?.env ?? env, expected: TEXT, bindings })),
        }));
      }
      return {
        id: rule.id ?? `${section.name}#${index + 1}`,
        selectFirst,
        when: expand(`${ruleLabel} when`, rule.when, { environment: selectFirst?.env ?? env, bindings }),
        whenAsWritten: rule.when,
        action,
        params: deepFreeze(params),
        placeholders,
        why: rule.why ?? null,
      };
    });
    errors.push(...sharedIdErrors(label, section.rules ?? []));
    const hitPolicy = section.hitPolicy ?? document.hitPolicyDefault ?? 'FIRST';
    errors.push(...catchAllErrors(label, section, hitPolicy, rules, { env, actionGuards }));
    return {
      name: section.name,
      when: expand(`${label} when`, section.when),
      whenAsWritten: section.when,
      needs: section.needs ?? {},
      hitPolicy,
      rules,
    };
  });

  const guards = guardsOf(sections, actionGuards);
  for (const [action, guard] of guards) compile(`action "${action}" guard`, guard);

  const outputs = document.outputs ?? null;
  errors.push(...outputErrors(outputs ?? [], registry, declaredKeys));

  const problems = unresolvedErrors(errors, checks.failure);
  if (problems.length) throw new RulebookError(problems);
  return { sections, declaredKeys, env, templated, guards, outputs, macros: [...checks.callable.values()] };
}

// What every check against a registry shares, a rulebook's and a macro file's (since 0.3): the registry's
// own problems, the CEL environment, the keys known (the registry's, plus `knownKeys`), and the checks of
// one expression, with the macros `imported` (readImports) expanded. `errors` collects every problem, in
// order; `unknownKeyHint` follows an unknown key's message.
function prepareChecks(registry, { imported, knownKeys, unknownKeyHint = '' }) {
  const { visible: macros, all: importedMacros, errors: importErrors } = imported;
  const { env, errors: functionErrors } = makeEnvironment(registry);
  const { checkers: paramsCheckers, errors: paramsSchemaErrors } = compileParamsCheckers(registry.actions);
  const { templated, withProblems: templatesWithProblems, errors: templatesErrors } = compileTemplatedParams(registry.actions);
  // A rule's braces aren't reported again for an action whose entry already has a problem that explains
  // them: a bad `templates`, no `params` (which the params check reports), or an unknown key that lists the
  // param (a misspelled `templates`). Any other key problem explains nothing about the braces.
  const isBraceCheckable = (action, param) => !templatesWithProblems.has(action) && registry.actions[action].params !== undefined
    && !unknownKeyLists(registry.actions[action], param);
  // The helpers are known only as `belaykit.<name>` (unknownFunctionsIn), so `present(…)` alone is unknown.
  const knownFunctions = new Set([
    ...CEL_MACROS,
    ...env.getDefinitions().functions.filter(({ receiverType }) => receiverType !== NAMESPACE_TYPE).map(({ name }) => name),
  ]);
  const knownFields = new Set([
    ...knownKeys,
    ...(registry.initialKeys ?? []),
    ...Object.values(registry.actions).flatMap((action) => action.writes ?? []),
    ...Object.values(registry.producers).flatMap((producer) => producer.writes ?? []),
  ]);

  const { shapes, errors: shapesErrors } = compileShapes(registry.shapes, knownFields);

  const keyArgsByName = new Map((registry.functions ?? [])
    .filter((definition) => definition.keyArgs)
    .map((definition) => [nameInSignature(definition.signature), definition.keyArgs]));

  const actionGuards = readGuards(registry.actions);
  const macroCheck = checkMacroDefinitions(importedMacros, {
    parse: (expression) => env.parse(expression).ast,
    nameProblem: (name) => macroNameProblem(name, knownFunctions, registry),
    paramProblem: (name) => macroParamProblem(name, registry, env),
  });
  const errors = [...importErrors, ...macroCheck.problems, ...registryKeyErrors(registry), ...guardTypeErrors(actionGuards), ...functionErrors, ...paramsSchemaErrors, ...templatesErrors, ...shapesErrors];
  // A `when` must be a boolean, and a `selectFirst` expression a list. `dyn` is accepted
  // here and checked when evaluated (provider.js). A rule that selects compiles its `when`
  // in its own environment, which adds the binding.
  // `params`: in a macro's body, the names whose value each call supplies, so a check that needs a literal
  // (a pattern, a helper's path) is made where the macro is called.
  const problemsOf = (expression, { environment = env, expected = PREDICATE, bindings, params = new Set() } = {}) => {
    const literalChecks = { patternErrors: (node) => patternErrors(node, params), helperPathErrors: (node) => helperPathErrors(node, params) };
    const result = environment.check(expression);
    if (!result.valid) {
      const unknown = unknownFunctionsIn(environment, expression, knownFunctions);
      // A name an import that didn't load might have defined is reported once for the whole rulebook (unresolvedErrors).
      const messages = unknown.length ? unknown.map((name) => (imported.failure !== null ? unresolved(name) : `unknown function "${name}"`))
        : [result.error?.message?.split('\n')[0] ?? 'does not compile'];
      const ownErrors = syntaxTreeErrorsIn(environment, expression, [reservedVariableErrors, literalChecks.helperPathErrors]);
      return [...ownErrors, ...messages];
    }
    const typeErrors = expected.accepts(result.type) ? [] : [`has type ${result.type}, expected ${expected.name}`];
    const { ast } = environment.parse(expression);
    const nodes = [...nodesOf(ast)];
    const references = [...nodes.map(wsPathOf), ...nodes.map((node) => helperKeyPathOf(node, keyArgsByName))].filter(Boolean);
    // A key or field problem names what it is about, so the same one twice is one mistake. The syntax-tree checks
    // after it don't say which call they mean, so each call keeps its own problem: two calls, two fixes.
    const expressionErrors = [
      ...distinct([
        ...references.flatMap((path) => unknownKeyErrors(path, knownFields, unknownKeyHint)),
        ...nodes.flatMap((node) => helperPathKeyErrors(node, knownFields, unknownKeyHint)),
        ...shapeErrors(ast, { shapes, bindings, keyArgsByName }),
      ]),
      ...nodes.flatMap(literalChecks.patternErrors),
      ...nodes.flatMap(reservedVariableErrors),
      ...nodes.flatMap(literalChecks.helperPathErrors),
    ];
    return [...typeErrors, ...expressionErrors];
  };
  const compile = (owner, expression, options) => {
    errors.push(...problemsOf(expression, options).map((problem) => `${owner}: ${problem}`));
    return expression;
  };
  // An expression that may call macros (`scope` is what it can call): its own text is checked with each call
  // standing in for a value, then its expansion, whose problems the call's own text and the macros' bodies
  // didn't already report are the macros' to name. Returns the expansion, the text the run evaluates.
  const bodyProblems = new Map();
  const expandIn = (scope) => (owner, expression, options = {}) => {
    const site = macroSite(expression, { parse: (text) => env.parse(text).ast, scope, macroCheck });
    if (site === null) {
      const problems = problemsOf(expression, options);
      errors.push(...problems.map((problem) => `${owner}: ${problem}`));
      return { text: expression, reported: new Set(problems) };
    }
    const ownProblems = problemsOf(site.standIn, options);
    errors.push(...[...site.problems, ...ownProblems].map((problem) => `${owner}: ${problem}`));
    if (site.expanded === null) return { text: expression, reported: new Set(ownProblems) };
    const known = new Set([...ownProblems, ...site.called.flatMap((macro) => [...bodyProblemsOf(macro)])]);
    // Each called macro is expanded alone first, so a problem is named by the macro it comes through;
    // what only the whole expansion shows is named by them all.
    const reportThrough = (macros, expression) => {
      const problems = problemsOf(expression, options).filter((problem) => !known.has(problem));
      const where = `${owner}, in ${macros.length === 1 ? 'macro' : 'macros'} ${macros.map(({ name }) => `"${name}"`).join(', ')}`;
      errors.push(...problems.map((problem) => `${where}: ${problem}`));
      for (const problem of problems) known.add(problem);
    };
    if (site.called.length > 1) for (const macro of site.called) reportThrough([macro], site.expandedWith(macro));
    reportThrough(site.called, site.expanded);
    return { text: site.expanded, reported: known };
  };
  // A body's problems, once per macro called, reported on the macro: its params stand for any value.
  function bodyProblemsOf(macro) {
    if (!bodyProblems.has(macro)) {
      bodyProblems.set(macro, new Set());
      const environment = macro.params.reduce((bodyEnv, param) => bodyEnv.registerVariable(param, 'dyn'), env.clone());
      const options = { environment, expected: ANY, params: new Set(macro.params) };
      bodyProblems.set(macro, expandIn(macro.scope)(labelOf(macro), macro.body, options).reported);
    }
    return bodyProblems.get(macro);
  }
  // A macro whose name is refused isn't callable: the name stays CEL's or the registry's (checkMacroDefinitions).
  const callable = new Map([...macros].filter(([name]) => !macroCheck.refused.has(name)));
  return { env, shapes, errors, compile, expandIn, bodyProblemsOf, callable, macroCheck, paramsCheckers, templated, isBraceCheckable, actionGuards, failure: imported.failure };
}

// While an import has a problem, a call to a name nothing defines may be to a macro it would have defined,
// or a typo. Either way it's reported once per name, in its first use's place in the list, with how many
// expressions use it: not once per expression, which would bury the import's own problem.
const UNRESOLVED = '\u0000unresolved:';
const unresolved = (name) => `${UNRESOLVED}${name}`;

function unresolvedErrors(errors, failure) {
  const countOf = new Map();
  for (const error of errors) {
    const name = unresolvedNameIn(error);
    if (name !== null) countOf.set(name, (countOf.get(name) ?? 0) + 1);
  }
  return errors.flatMap((error) => {
    const name = unresolvedNameIn(error);
    if (name === null) return [error];
    if (!countOf.has(name)) return [];
    const count = countOf.get(name);
    countOf.delete(name);
    return [`unknown function "${name}", used in ${count} expression${count === 1 ? '' : 's'} (${failure})`];
  });
}

const unresolvedNameIn = (error) => (error.includes(UNRESOLVED) ? error.slice(error.indexOf(UNRESOLVED) + UNRESOLVED.length) : null);

// Each action's guard (since 0.2), read once, through a class's getter too: the type check, the
// catch-all and the run all use this reading, so the guard checked is the guard run.
const readGuards = (actions) => new Map(Object.entries(actions)
  .map(([name, action]) => [name, action.guard])
  .filter(([, guard]) => guard !== undefined));

// The guards of the actions a rule names, kept for the run. Each is checked once, like a `when`, and only
// for the actions this rulebook names: what `ws` holds depends on the rulebook. A guard that isn't a
// string is a registry problem (guardTypeErrors), and isn't compiled.
function guardsOf(sections, actionGuards) {
  const named = new Set(sections.flatMap((section) => section.rules.map((rule) => rule.action)));
  return new Map([...named].filter((action) => typeof actionGuards.get(action) === 'string').map((action) => [action, actionGuards.get(action)]));
}

// A guard is one CEL expression; anything else would be ignored, and the action left unguarded.
const guardTypeErrors = (actionGuards) => [...actionGuards]
  .filter(([, guard]) => typeof guard !== 'string')
  .map(([name]) => `action "${name}": guard must be a CEL expression (a string)`);

// A mistake an expression makes twice (the same unknown key read twice, say) is one problem for its author.
const distinct = (problems) => [...new Set(problems)];

// What `rules.decide` returns (since 0.2): each output must be written by some action, and
// none may be set by gathering (a needs key, or a producer's writes) before any rule decided it.
function outputErrors(outputs, registry, declaredKeys) {
  const written = new Set(Object.values(registry.actions).flatMap((action) => action.writes ?? []));
  const producerOf = (output) => Object.entries(registry.producers).find(([, producer]) => (producer.writes ?? []).includes(output))?.[0];
  return outputs.flatMap((output) => {
    if (declaredKeys.includes(output)) return [`output "${output}" is a needs key; its producer would set it`];
    const producer = producerOf(output);
    if (producer !== undefined) return [`output "${output}" is written by producer "${producer}", which would set it before any rule decides`];
    return written.has(output) ? [] : [`output "${output}": no action writes it`];
  });
}

// `selectFirst: { <name>: <list expression> }`. The expression is checked like any other
// (as a list); the rule gets its own environment with the name bound, so the binding
// exists in its own `when` and nowhere else. A name that can't be bound safely is
// refused, and the rule's `when` is then compiled without it.
function compileSelection(ruleLabel, selectFirst, { env, registry, compile, errors }) {
  const [[name, asWritten]] = Object.entries(selectFirst);
  const owner = `${ruleLabel} selectFirst`;
  const expression = compile(owner, asWritten, { expected: LIST });
  const problem = bindingProblem(name, registry);
  if (problem) {
    errors.push(`${owner}: binding "${name}" ${problem}`);
    // The rule's `when` still uses the name as its binding; in the rulebook's environment it would read as the
    // helpers' constant and add a misleading type problem. So it compiles where the name is the binding.
    return { name, expression, asWritten, env: name === NAMESPACE ? environmentBinding(name, registry) : env };
  }
  try {
    return { name, expression, asWritten, env: env.clone().registerVariable(name, 'dyn') };
  } catch {
    // cel-js predefines its type names (string, int, map, list, type, google…) as variables.
    errors.push(`${owner}: binding "${name}" is a name CEL already defines`);
    return { name, expression, asWritten, env };
  }
}

// A macro is called by its bare name, so the name can't be one a rulebook's CEL already calls.
function macroNameProblem(name, knownFunctions, registry) {
  if (name === NAMESPACE) return RESERVED;
  if (name === 'cel') return 'is CEL\'s own namespace';
  if (CEL_RESERVED_WORDS.has(name)) return 'is a CEL reserved word';
  const functionNames = (registry.functions ?? []).map(({ signature }) => nameInSignature(signature));
  if (functionNames.some((head) => head.slice(head.lastIndexOf('.') + 1) === name)) return 'is a registered function\'s name';
  return knownFunctions.has(name) ? 'is one of CEL\'s functions' : null;
}

// A param is a variable in the body, so it is named as a selectFirst binding is.
function macroParamProblem(name, registry, env) {
  const problem = bindingProblem(name, registry);
  if (problem) return problem;
  try {
    env.clone().registerVariable(name, 'dyn');
    return null;
  } catch {
    return 'is a name CEL already defines'; // cel-js predefines its type names as variables
  }
}

// A rule's params against its action's templates: each templated param's placeholders are compiled in
// the rule's environment, like its `when` (`compilePlaceholder` reports their problems itself); a brace
// anywhere in a param the action doesn't template is refused, so a placeholder never reaches an action as text.
function templateErrors(ruleLabel, action, params, templatedParams, { checkBraces, compilePlaceholder }) {
  return Object.entries(params).flatMap(([param, value]) => {
    if (!templatedParams.has(param)) {
      return checkBraces(param) && containsBrace(value) ? [`${ruleLabel}: param "${param}" has a brace, but "${action}" doesn't template "${param}"`] : [];
    }
    if (typeof value !== 'string') return []; // the params schema says it must be a string
    const { parts, problem } = parseTemplate(value);
    // The same placeholder written twice is one mistake, so it is compiled (and reported) once.
    const placeholders = new Map(parts.filter((part) => 'expression' in part).map(({ expression, source }) => [source, expression]));
    for (const [source, expression] of placeholders) {
      compilePlaceholder(`${ruleLabel} param "${param}" placeholder ${source}`, expression);
    }
    return problem ? [`${ruleLabel} param "${param}": ${problem}`] : [];
  });
}

const containsBrace = (value) => (value !== null && typeof value === 'object'
  ? Object.values(value).some(containsBrace)
  : hasPlaceholderSyntax(value));

// What the binding stands for, for the shape check: an item of the list its expression reads.
// An expression that doesn't parse was reported already, and leaves the binding unchecked.
function selectionBinding({ name, expression, env }, shapes) {
  try {
    return bindingFor(name, env.parse(expression).ast, shapes);
  } catch {
    return null; // the selectFirst expression's own check names the problem
  }
}

// A key the plugin doesn't read would otherwise be ignored without a word (a leftover
// `fields`, from before shapes, most of all), in the registry and on each producer and action
// (a misspelled `template` would leave a param untemplated).
function registryKeyErrors(registry) {
  return [
    ...unknownKeys('registry', registry, REGISTRY_KEYS),
    ...Object.entries(registry.producers).flatMap(([name, producer]) => unknownKeys(`producer "${name}"`, producer, PRODUCER_KEYS, ENTRY_HINT)),
    ...Object.entries(registry.actions).flatMap(([name, action]) => unknownKeys(`action "${name}"`, action, ACTION_KEYS, ENTRY_HINT)),
  ];
}

// An entry made from a class holds only these keys too: what it needs comes through `deps`.
const ENTRY_HINT = '; pass dependencies through deps';

// Whether an action's unknown key holds a list naming `param`, as a misspelled `templates` would.
const unknownKeyLists = (action, param) => Object.keys(action)
  .filter((key) => !ACTION_KEYS.includes(key))
  .some((key) => Array.isArray(action[key]) && action[key].includes(param));

const unknownKeys = (label, object, known, hint = '') => Object.keys(object).filter((key) => !known.includes(key))
  .map((key) => `${label}: unknown key "${key}" (keys: ${known.join(', ')}${hint})`);

function bindingProblem(name, registry) {
  if (name === 'ws') return 'would hide the working set';
  if (name === NAMESPACE) return RESERVED;
  if (CEL_RESERVED_WORDS.has(name)) return 'is a CEL reserved word';
  const functionNames = (registry.functions ?? []).map(({ signature }) => nameInSignature(signature));
  return functionNames.includes(name) ? 'is a registered function\'s name' : null;
}

// A FIRST section with rules says what happens when none holds: its last rule always holds (the literal
// `true`, read from the syntax tree, without selectFirst, which can fail on an empty list), or it says
// `exhaustive: false`, that no match is meant to end the run (since 0.2). Otherwise a claiming
// section that matches nothing would end the run where its author may have expected a fallback. A guard
// on the last rule's action can make it fail too (since 0.2), so that rule isn't a catch-all.
// The rules are the loaded ones, so a last rule calling a macro is judged by its expansion.
function catchAllErrors(label, section, hitPolicy, rules, { env, actionGuards }) {
  const isFirstWithRules = hitPolicy === 'FIRST' && rules.length > 0;
  if (Object.hasOwn(section, 'exhaustive')) {
    return isFirstWithRules ? [] : [`${label}: exhaustive applies to a FIRST section with rules`];
  }
  if (!isFirstWithRules) return [];
  const last = rules.at(-1);
  // A last rule whose when doesn't compile is reported for that; the author may well have meant `true`.
  if (!last.selectFirst && !env.check(last.when).valid) return [];
  if (last.selectFirst || !isLiteralTrue(last.when, env)) {
    return [`${label}: a FIRST section must end in a rule with when: "true" (without selectFirst), or say exhaustive: false`];
  }
  // A guard that isn't a string is still one the author meant (and is reported itself).
  const { action } = last;
  return !actionGuards.has(action) ? []
    : [`${label}: its last rule's action "${action}" has a guard, so the rule may not hold; end in a rule with when: "true" whose action has no guard, or say exhaustive: false`];
}

function isLiteralTrue(expression, env) {
  try {
    const { ast } = env.parse(expression);
    return ast.op === 'value' && ast.args === true;
  } catch {
    return false; // the rule's own check reports why it doesn't compile
  }
}

// A rule's id names its choice in the trace, so explicit ids must be unique in a section.
// (Defaults are `<section>#<n>`, and the schema keeps `#` out of explicit ids.)
function sharedIdErrors(label, rules) {
  const firstRuleById = new Map();
  return rules.flatMap((rule, index) => {
    if (rule.id === undefined) return [];
    if (!firstRuleById.has(rule.id)) {
      firstRuleById.set(rule.id, index + 1);
      return [];
    }
    return [`${label} rules ${firstRuleById.get(rule.id)} and ${index + 1} share id "${rule.id}"`];
  });
}

// cel-js reports a call to a name it doesn't define as "found no matching overload", which
// reads as an argument problem. The names nothing defines are found in the syntax tree.
function unknownFunctionsIn(environment, expression, knownFunctions) {
  let ast;
  try {
    ast = environment.parse(expression).ast;
  } catch {
    return []; // a syntax error: the check's own message says where
  }
  const unknown = [...nodesOf(ast)].filter((node) => node.op === 'call' || node.op === 'rcall').flatMap((node) => {
    const name = node.args[0];
    if (isHelperCall(node)) return HELPER_NAMES.has(name) ? [] : [`${NAMESPACE}.${name}`];
    return knownFunctions.has(name) ? [] : [name];
  });
  return [...new Set(unknown)];
}

const isHelperCall = (node) => node.op === 'rcall' && node.args[1]?.op === 'id' && node.args[1].args === NAMESPACE;

// A CEL macro's variable named like the helpers' namespace would hide them inside its body. Besides the list
// macros, cel-js has `cel.bind(var, value, expr)`, a method of its own `cel` namespace.
function reservedVariableErrors(node) {
  if (node.op !== 'rcall' || !(CEL_MACROS.includes(node.args[0]) || isCelBind(node))) return [];
  const variable = node.args[2]?.[0];
  return variable?.op === 'id' && variable.args === NAMESPACE ? [`CEL macro variable "${NAMESPACE}" ${RESERVED}`] : [];
}

const isCelBind = (node) => node.args[0] === 'bind' && node.args[1]?.op === 'id' && node.args[1].args === 'cel';

// A helper's path is checked at load like the field access it stands for (shapes.js), so it must be a
// string literal, as a `matches` pattern must.
function helperPathErrors(node, params = new Set()) {
  const call = helperPathCallOf(node);
  if (!call || isParam(call.path, params)) return [];
  const path = literalStringOf(call.path);
  if (path === null) return [`${NAMESPACE}.${call.name}: path must be a string literal`];
  return path.split('.').includes('') ? [pathProblem(call.name, path, EMPTY_SEGMENT)] : [];
}

// belaykit.present(ws, "fact.recurrence") reads ws.fact, so a path's first key must be a known one when
// the container is ws itself. (A container such as ws.facts is its own node, checked as a reference.)
function helperPathKeyErrors(node, knownFields, hint) {
  const call = helperPathCallOf(node);
  const path = call && literalStringOf(call.path);
  if (!path || call.container.op !== 'id' || call.container.args !== 'ws') return [];
  const [key] = path.split('.');
  return key === '' ? [] : unknownKeyErrors([key], knownFields, hint).map((error) => pathProblem(call.name, path, error));
}

// For an expression that fails cel-js's check, the problems read from its syntax tree: the reserved name or
// a helper's path may be the cause, so they're reported too.
function syntaxTreeErrorsIn(environment, expression, checks) {
  try {
    const nodes = [...nodesOf(environment.parse(expression).ast)];
    return checks.flatMap((check) => nodes.flatMap(check));
  } catch {
    return []; // a syntax error: the check's own message says where
  }
}

// The ws path an access node reads, through dots and literal subscripts: ['key'] for
// ws.key or ws["key"], ['key', 'field'] for ws.key.field. Null for anything else.
function wsPathOf(node) {
  if (node.op === 'id') return node.args === 'ws' ? [] : null;
  if (node.op !== '.' && node.op !== '[]') return null;
  const name = node.op === '.' ? node.args[1] : literalStringOf(node.args[1]);
  const parent = name === null ? null : wsPathOf(node.args[0]);
  return parent && [...parent, name];
}

// A call to a helper with keyArgs reads a field too: helper(ws.write, "action") reads
// ws.write.action. Only a literal key in a container on the ws path can be checked.
function helperKeyPathOf(node, keyArgsByName) {
  if (node.op !== 'call' || !keyArgsByName.has(node.args[0])) return null;
  const { key, in: container } = keyArgsByName.get(node.args[0]);
  const argumentNodes = node.args[1];
  const keyName = argumentNodes[key] ? literalStringOf(argumentNodes[key]) : null;
  const containerPath = argumentNodes[container] ? wsPathOf(argumentNodes[container]) : null;
  if (keyName === null || containerPath === null || containerPath.length > 1) return null;
  return [...containerPath, keyName];
}

// cel-js runs `matches` with JavaScript's backtracking RegExp, on values that may be model
// output. So a pattern must be a literal we can check here: one that compiles, and that
// safe-regex2 (a heuristic) doesn't flag as exponential.
function patternErrors(node, params = new Set()) {
  if (node.op !== 'rcall' || node.args[0] !== 'matches' || isParam(node.args[2][0], params)) return [];
  const pattern = literalStringOf(node.args[2][0]);
  if (pattern === null) return ['pattern must be a string literal'];
  if (!compiles(pattern)) return [`pattern "${pattern}" is not a valid regular expression`];
  return isSafeRegex(pattern) ? [] : [`pattern "${pattern}" may backtrack exponentially`];
}

function compiles(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false; // the caller's message names the pattern and the rule

  }
}

const literalStringOf = (node) => (node.op === 'value' && typeof node.args === 'string' ? node.args : null);

// A macro's param, where a literal is required: the call supplies it, and the expansion is checked there.
const isParam = (node, params) => node?.op === 'id' && params.has(node.args);

// Each prefix of a path is its own node, so checking one-name paths covers every key a
// rulebook reads. Fields below a key are the shapes' to check (shapes.js).
function unknownKeyErrors([key, ...fields], knownFields, hint = '') {
  if (key === undefined || fields.length > 0) return [];
  if (knownFields.has(key)) return [];
  return [`unknown ws field "${key}"${Object.hasOwn(RETIRED_FIELDS, key) ? ` (${RETIRED_FIELDS[key]})` : ''}${hint}`];
}

// Registers BelayKit's helpers, then the registry's functions, returning registry errors
// (reported once, not per rule) beside the environment. A function with a bad name isn't
// registered.
export function makeEnvironment(registry, { withHelpers = true } = {}) {
  const env = new Environment().registerVariable('ws', 'map');
  if (withHelpers) registerHelpers(env);
  const errors = (registry.functions ?? []).flatMap((definition) => registerFunction(env, definition));
  return { env, errors };
}

// An environment, without the helpers, where `name` is a binding: for a rule whose binding took the helpers' name
// (already refused), so its `when` is checked for its own problems only.
const environmentBinding = (name, registry) => makeEnvironment(registry, { withHelpers: false }).env.registerVariable(name, 'dyn');

// 'app_state(map, string): string' -> 'app_state'; a method keeps its receiver ('string.app_x').
export const nameInSignature = (signature) => signature.slice(0, signature.indexOf('(')).trim();

function registerFunction(env, { keyArgs, ...definition }) {
  const head = nameInSignature(definition.signature);
  const name = head.slice(head.lastIndexOf('.') + 1);
  if (head === NAMESPACE) return [`function "${head}": the name ${RESERVED}`];
  // The helpers' type would otherwise take a registry's methods, so a registry could change the namespace.
  if (head.startsWith(`${NAMESPACE_TYPE}.`)) return [`function "${head}": ${NAMESPACE_TYPE} is the type of BelayKit's helpers; a registry can't add to it`];
  if (!FUNCTION_NAME.test(name)) return [`function "${head}": names must match ${FUNCTION_NAME.source} (lower snake case or camelCase)`];
  if (keyArgs && name !== head) return [`function "${head}": keyArgs applies to global functions, not methods`];
  try {
    env.registerFunction(definition);
    return [];
  } catch (error) {
    // cel-js reads `app.matches` as a method on an unknown type `app`.
    if (head.includes('.') && /Unknown type/.test(error.message)) {
      return [`function "${head}": dots aren't allowed in names; use ${head.replaceAll('.', '_')}`];
    }
    // A method on `dyn` named like a helper would apply to the helpers' type too.
    if (new RegExp(`overlaps with existing overload '${NAMESPACE_TYPE}\\.`).test(error.message)) {
      return [`function "${head}": a method on ${head.slice(0, head.lastIndexOf('.'))} named "${name}" would also apply to ${NAMESPACE}.${name}; rename it`];
    }
    return [`function "${head}": ${error.message.split('\n')[0]}`];
  }
}

const isName = (value) => typeof value === 'string' && NAME.test(value);

// '/sections/1/rules/0/when' -> 'section "decide" rule 1 (urgent) when', named as the loader
// names sections and rules elsewhere; a section or rule whose name is itself the problem is
// named by position, counting from 1.
function rulebookPlace(document, instancePath) {
  const [first, sectionIndex, ...afterSection] = instancePath.split('/').slice(1);
  if (first !== 'sections' || sectionIndex === undefined) return keyPathPlace(instancePath);
  const section = document.sections[Number(sectionIndex)];
  const sectionPlace = isName(section?.name) ? `section "${section.name}"` : `section ${Number(sectionIndex) + 1}`;
  const [inSection, ruleIndex, ...afterRule] = afterSection;
  if (inSection !== 'rules' || ruleIndex === undefined) return [sectionPlace, afterSection.join('.')].filter(Boolean).join(' ');
  const rule = section?.rules?.[Number(ruleIndex)];
  const rulePlace = `rule ${Number(ruleIndex) + 1}${isName(rule?.id) ? ` (${rule.id})` : ''}`;
  return [sectionPlace, rulePlace, afterRule.join('.')].filter(Boolean).join(' ');
}

// A rule's params are literals from the file. They're handed to its action on every run,
// so they're read-only: an action that changed them would change every later run.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
