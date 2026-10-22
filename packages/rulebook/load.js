// Loads a BelayKit rulebook (YAML + CEL) and rejects every static problem
// before anything runs: schema, badly named or unregistrable functions,
// unregistered producers and actions, CEL that fails to compile, predicates of a
// known non-boolean type, rules sharing an explicit id, ws fields nothing declares
// (read from the syntax tree, including keys passed to helpers), `matches`
// patterns that aren't safe literals, any use of the name reserved for
// BelayKit's own helpers (`belaykit`, helpers.js), and a helper's path that isn't a
// literal or names a field nothing declares.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { Environment } from '@marcbachmann/cel-js';
import isSafeRegex from 'safe-regex2';
import { YAMLError, parse as parseYaml } from 'yaml';
import { EMPTY_SEGMENT, HELPER_NAMES, NAMESPACE, NAMESPACE_TYPE, helperPathCallOf, pathProblem, registerHelpers } from './helpers.js';
import { compileParamsCheckers, compileTemplatedParams, paramsProblems } from './params.js';
import { bindingFor, compileShapes, shapeErrors } from './shapes.js';
import { hasPlaceholderSyntax, parseTemplate } from './templates.js';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

// The plugin maintains no field of its own: every key, a terminal field included, is the
// agent's to declare. A field it once maintained is named with what replaced it.
const RETIRED_FIELDS = { gathered: 'gone in 0.2: test has(ws.<key>) for a gathered key' };
const PREDICATE = { name: 'bool', accepts: (type) => type === 'bool' || type === 'dyn' };
const LIST = { name: 'list', accepts: (type) => type === 'dyn' || type.startsWith('list') };
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

export function loadRulebook(path, registry) {
  return loadRulebookText(readFileSync(path, 'utf-8'), registry);
}

// Every problem in a rulebook, one string each; [] when it's clean. A problem in the
// file is returned, never thrown; a broken registry still throws.
export function checkRulebook(text, registry) {
  try {
    loadRulebookText(text, registry);
    return [];
  } catch (error) {
    if (error instanceof RulebookError) return error.problems;
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

export function loadRulebookText(text, registry) {
  const document = parseRulebookYaml(text);
  if (!validateSchema(document)) {
    // A bad property name comes as two errors: the name's own (kept) and a generic one.
    const errors = validateSchema.errors.filter((error) => error.keyword !== 'propertyNames');
    throw new RulebookError([...new Set(errors.map((error) => schemaMessage(error, (path) => rulebookPlace(document, path))))]);
  }

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
  const declaredKeys = [...new Set(document.sections.flatMap((section) => Object.keys(section.needs ?? {})))];
  const knownFields = new Set([
    ...declaredKeys,
    ...(registry.initialKeys ?? []),
    ...Object.values(registry.actions).flatMap((action) => action.writes ?? []),
    ...Object.values(registry.producers).flatMap((producer) => producer.writes ?? []),
  ]);

  const { shapes, errors: shapesErrors } = compileShapes(registry.shapes, knownFields);

  const keyArgsByName = new Map((registry.functions ?? [])
    .filter((definition) => definition.keyArgs)
    .map((definition) => [nameInSignature(definition.signature), definition.keyArgs]));

  const actionGuards = readGuards(registry.actions);
  const errors = [...registryKeyErrors(registry), ...guardTypeErrors(actionGuards), ...functionErrors, ...paramsSchemaErrors, ...templatesErrors, ...shapesErrors];
  // A `when` must be a boolean, and a `selectFirst` expression a list. `dyn` is accepted
  // here and checked when evaluated (provider.js). A rule that selects compiles its `when`
  // in its own environment, which adds the binding.
  const compile = (owner, expression, { environment = env, expected = PREDICATE, bindings } = {}) => {
    const result = environment.check(expression);
    if (!result.valid) {
      const unknown = unknownFunctionsIn(environment, expression, knownFunctions);
      const messages = unknown.length ? unknown.map((name) => `unknown function "${name}"`) : [result.error?.message?.split('\n')[0] ?? 'does not compile'];
      const ownErrors = syntaxTreeErrorsIn(environment, expression, [reservedVariableErrors, helperPathErrors]);
      errors.push(...[...ownErrors, ...messages].map((message) => `${owner}: ${message}`));
      return expression;
    }
    if (!expected.accepts(result.type)) errors.push(`${owner}: has type ${result.type}, expected ${expected.name}`);
    const { ast } = environment.parse(expression);
    const nodes = [...nodesOf(ast)];
    const references = [...nodes.map(wsPathOf), ...nodes.map((node) => helperKeyPathOf(node, keyArgsByName))].filter(Boolean);
    // A key or field problem names what it is about, so the same one twice is one mistake. The syntax-tree checks
    // after it don't say which call they mean, so each call keeps its own problem: two calls, two fixes.
    const expressionErrors = [
      ...distinct([
        ...references.flatMap((path) => unknownKeyErrors(path, knownFields)),
        ...nodes.flatMap((node) => helperPathKeyErrors(node, knownFields)),
        ...shapeErrors(ast, { shapes, bindings, keyArgsByName }),
      ]),
      ...nodes.flatMap(patternErrors),
      ...nodes.flatMap(reservedVariableErrors),
      ...nodes.flatMap(helperPathErrors),
    ];
    errors.push(...expressionErrors.map((error) => `${owner}: ${error}`));
    return expression;
  };

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
      const selectFirst = rule.selectFirst ? compileSelection(ruleLabel, rule.selectFirst, { env, registry, compile, errors }) : null;
      const bindings = selectFirst ? new Map([[selectFirst.name, selectionBinding(selectFirst, shapes)]]) : undefined;
      if (Object.hasOwn(registry.actions, action)) {
        const templatedParams = templated.get(action) ?? new Set();
        errors.push(...templateErrors(ruleLabel, action, params, templatedParams, {
          checkBraces: (param) => isBraceCheckable(action, param),
          compilePlaceholder: (owner, expression) => compile(owner, expression, { environment: selectFirst?.env ?? env, expected: TEXT, bindings }),
        }));
      }
      return {
        id: rule.id ?? `${section.name}#${index + 1}`,
        selectFirst,
        when: compile(`${ruleLabel} when`, rule.when, { environment: selectFirst?.env ?? env, bindings }),
        action,
        params: deepFreeze(params),
        why: rule.why ?? null,
      };
    });
    errors.push(...sharedIdErrors(label, section.rules ?? []));
    const hitPolicy = section.hitPolicy ?? document.hitPolicyDefault ?? 'FIRST';
    errors.push(...catchAllErrors(label, section, hitPolicy, { env, actionGuards }));
    return {
      name: section.name,
      when: compile(`${label} when`, section.when),
      needs: section.needs ?? {},
      hitPolicy,
      rules,
    };
  });

  const guards = guardsOf(sections, actionGuards);
  for (const [action, guard] of guards) compile(`action "${action}" guard`, guard);

  const outputs = document.outputs ?? null;
  errors.push(...outputErrors(outputs ?? [], registry, declaredKeys));

  if (errors.length) throw new RulebookError(errors);
  return { sections, declaredKeys, env, templated, guards, outputs };
}

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
  const [[name, expression]] = Object.entries(selectFirst);
  const owner = `${ruleLabel} selectFirst`;
  compile(owner, expression, { expected: LIST });
  const problem = bindingProblem(name, registry);
  if (problem) {
    errors.push(`${owner}: binding "${name}" ${problem}`);
    // The rule's `when` still uses the name as its binding; in the rulebook's environment it would read as the
    // helpers' constant and add a misleading type problem. So it compiles where the name is the binding.
    return { name, expression, env: name === NAMESPACE ? environmentBinding(name, registry) : env };
  }
  try {
    return { name, expression, env: env.clone().registerVariable(name, 'dyn') };
  } catch {
    // cel-js predefines its type names (string, int, map, list, type, google…) as variables.
    errors.push(`${owner}: binding "${name}" is a name CEL already defines`);
    return { name, expression, env };
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
function catchAllErrors(label, section, hitPolicy, { env, actionGuards }) {
  const rules = section.rules ?? [];
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
  const { action } = last.then;
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

// A macro's variable named like the helpers' namespace would hide them inside its body. Besides the list
// macros, cel-js has `cel.bind(var, value, expr)`, a method of its own `cel` namespace.
function reservedVariableErrors(node) {
  if (node.op !== 'rcall' || !(CEL_MACROS.includes(node.args[0]) || isCelBind(node))) return [];
  const variable = node.args[2]?.[0];
  return variable?.op === 'id' && variable.args === NAMESPACE ? [`macro variable "${NAMESPACE}" ${RESERVED}`] : [];
}

const isCelBind = (node) => node.args[0] === 'bind' && node.args[1]?.op === 'id' && node.args[1].args === 'cel';

// A helper's path is checked at load like the field access it stands for (shapes.js), so it must be a
// string literal, as a `matches` pattern must.
function helperPathErrors(node) {
  const call = helperPathCallOf(node);
  if (!call) return [];
  const path = literalStringOf(call.path);
  if (path === null) return [`${NAMESPACE}.${call.name}: path must be a string literal`];
  return path.split('.').includes('') ? [pathProblem(call.name, path, EMPTY_SEGMENT)] : [];
}

// belaykit.present(ws, "fact.recurrence") reads ws.fact, so a path's first key must be a known one when
// the container is ws itself. (A container such as ws.facts is its own node, checked as a reference.)
function helperPathKeyErrors(node, knownFields) {
  const call = helperPathCallOf(node);
  const path = call && literalStringOf(call.path);
  if (!path || call.container.op !== 'id' || call.container.args !== 'ws') return [];
  const [key] = path.split('.');
  return key === '' ? [] : unknownKeyErrors([key], knownFields).map((error) => pathProblem(call.name, path, error));
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

// Every node of a parsed CEL expression, depth first.
function* nodesOf(node) {
  yield node;
  for (const child of childNodesOf(node.args)) yield* nodesOf(child);
}

const childNodesOf = (args) => {
  if (Array.isArray(args)) return args.flatMap(childNodesOf);
  return args !== null && typeof args === 'object' && 'op' in args ? [args] : [];
};

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
function patternErrors(node) {
  if (node.op !== 'rcall' || node.args[0] !== 'matches') return [];
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

// Each prefix of a path is its own node, so checking one-name paths covers every key a
// rulebook reads. Fields below a key are the shapes' to check (shapes.js).
function unknownKeyErrors([key, ...fields], knownFields) {
  if (key === undefined || fields.length > 0) return [];
  if (knownFields.has(key)) return [];
  return [`unknown ws field "${key}"${Object.hasOwn(RETIRED_FIELDS, key) ? ` (${RETIRED_FIELDS[key]})` : ''}`];
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

// A schema problem in the file's own words: where it is (`placeOf` turns ajv's JSON path into
// a place), then what's wrong, with an enum's allowed values spelled out.
export function schemaMessage(error, placeOf = keyPathPlace) {
  const where = placeOf(error.instancePath);
  // The schema checks property names only for selectFirst, whose one key is the binding.
  if (error.propertyName !== undefined) return `${where}: binding "${error.propertyName}" ${error.message}`;
  if (error.keyword === 'additionalProperties') return `${where}: unknown key "${error.params.additionalProperty}"`;
  if (error.keyword === 'enum') return `${where}: must be one of ${error.params.allowedValues.join(', ')}`;
  if (error.keyword === 'const') return `${where}: must be ${JSON.stringify(error.params.allowedValue)}`;
  return `${where}: ${error.message}`;
}

const isName = (value) => typeof value === 'string' && NAME.test(value);

// '/expect/status' -> 'expect.status'.
const keyPathPlace = (instancePath) => instancePath.split('/').slice(1).join('.') || '(top level)';

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
