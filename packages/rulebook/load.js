// Loads a BelayKit rulebook (YAML + CEL) and rejects every static problem
// before anything runs: schema, badly named or unregistrable functions,
// unregistered producers and actions, CEL that fails to compile, predicates of a
// known non-boolean type, rules sharing an explicit id, ws fields nothing declares
// (read from the syntax tree, including keys passed to helpers), and `matches`
// patterns that aren't safe literals.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { Environment } from '@marcbachmann/cel-js';
import isSafeRegex from 'safe-regex2';
import { YAMLError, parse as parseYaml } from 'yaml';
import { compileParamsCheckers, paramsProblems } from './params.js';
import { bindingFor, compileShapes, shapeErrors } from './shapes.js';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

// The one field the plugin itself maintains on every working set. Anything else, a
// terminal field included, is the agent's to declare.
const HARNESS_FIELDS = ['gathered'];
const PREDICATE = { name: 'bool', accepts: (type) => type === 'bool' || type === 'dyn' };
const LIST = { name: 'list', accepts: (type) => type === 'dyn' || type.startsWith('list') };
// cel-js accepts these as variable names, but `true` then reads as the literal and `in`
// can't be parsed, so a binding may not use them (CEL's reserved words).
const CEL_RESERVED_WORDS = new Set([
  'true', 'false', 'null', 'in', 'as', 'break', 'const', 'continue', 'else', 'for', 'function', 'if', 'import', 'let',
  'loop', 'package', 'namespace', 'return', 'var', 'void', 'while',
]);
const FUNCTION_NAME = /^[a-z][a-zA-Z0-9_]*$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const REGISTRY_KEYS = ['producers', 'actions', 'functions', 'version', 'initialKeys', 'shapes'];
// cel-js expands these itself, so they aren't among its function definitions.
const CEL_MACROS = ['has', 'all', 'exists', 'exists_one', 'map', 'filter'];

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
  const knownFunctions = new Set([...CEL_MACROS, ...env.getDefinitions().functions.map(({ name }) => name)]);
  const declaredKeys = [...new Set(document.sections.flatMap((section) => Object.keys(section.needs ?? {})))];
  const knownFields = new Set([
    ...HARNESS_FIELDS,
    ...declaredKeys,
    ...(registry.initialKeys ?? []),
    ...Object.values(registry.actions).flatMap((action) => action.writes ?? []),
    ...Object.values(registry.producers).flatMap((producer) => producer.writes ?? []),
  ]);

  const { shapes, errors: shapesErrors } = compileShapes(registry.shapes, knownFields);

  const keyArgsByName = new Map((registry.functions ?? [])
    .filter((definition) => definition.keyArgs)
    .map((definition) => [nameInSignature(definition.signature), definition.keyArgs]));

  const errors = [...registryKeyErrors(registry), ...functionErrors, ...paramsSchemaErrors, ...shapesErrors];
  // A `when` must be a boolean, and a `selectFirst` expression a list. `dyn` is accepted
  // here and checked when evaluated (provider.js). A rule that selects compiles its `when`
  // in its own environment, which adds the binding.
  const compile = (owner, expression, { environment = env, expected = PREDICATE, bindings } = {}) => {
    const result = environment.check(expression);
    if (!result.valid) {
      const unknown = unknownFunctionsIn(environment, expression, knownFunctions);
      const messages = unknown.length ? unknown.map((name) => `unknown function "${name}"`) : [result.error?.message?.split('\n')[0] ?? 'does not compile'];
      errors.push(...messages.map((message) => `${owner}: ${message}`));
      return expression;
    }
    if (!expected.accepts(result.type)) errors.push(`${owner}: has type ${result.type}, expected ${expected.name}`);
    const { ast } = environment.parse(expression);
    const nodes = [...nodesOf(ast)];
    const references = [...nodes.map(wsPathOf), ...nodes.map((node) => helperKeyPathOf(node, keyArgsByName))].filter(Boolean);
    const expressionErrors = [
      ...references.flatMap((path) => unknownKeyErrors(path, knownFields)),
      ...shapeErrors(ast, { shapes, bindings, keyArgsByName }),
      ...nodes.flatMap(patternErrors),
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
    return {
      name: section.name,
      when: compile(`${label} when`, section.when),
      needs: section.needs ?? {},
      hitPolicy: section.hitPolicy ?? document.hitPolicyDefault ?? 'FIRST',
      rules,
    };
  });

  if (errors.length) throw new RulebookError(errors);
  return { sections, declaredKeys, env };
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
    return { name, expression, env };
  }
  try {
    return { name, expression, env: env.clone().registerVariable(name, 'dyn') };
  } catch {
    // cel-js predefines its type names (string, int, map, list, type, google…) as variables.
    errors.push(`${owner}: binding "${name}" is a name CEL already defines`);
    return { name, expression, env };
  }
}

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
// `fields`, from before shapes, most of all).
function registryKeyErrors(registry) {
  return Object.keys(registry).filter((key) => !REGISTRY_KEYS.includes(key))
    .map((key) => `registry: unknown key "${key}" (keys: ${REGISTRY_KEYS.join(', ')})`);
}

function bindingProblem(name, registry) {
  if (name === 'ws') return 'would hide the working set';
  if (CEL_RESERVED_WORDS.has(name)) return 'is a CEL reserved word';
  const functionNames = (registry.functions ?? []).map(({ signature }) => nameInSignature(signature));
  return functionNames.includes(name) ? 'is a registered function\'s name' : null;
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
  const called = [...nodesOf(ast)].filter((node) => node.op === 'call' || node.op === 'rcall').map((node) => node.args[0]);
  return [...new Set(called.filter((name) => !knownFunctions.has(name)))];
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
  return knownFields.has(key) ? [] : [`unknown ws field "${key}"`];
}

// Registers the registry's functions, returning registry errors (reported once, not per
// rule) beside the environment. A function with a bad name isn't registered.
export function makeEnvironment(registry) {
  const env = new Environment().registerVariable('ws', 'map');
  const errors = (registry.functions ?? []).flatMap((definition) => registerFunction(env, definition));
  return { env, errors };
}

// 'app_state(map, string): string' -> 'app_state'; a method keeps its receiver ('string.app_x').
export const nameInSignature = (signature) => signature.slice(0, signature.indexOf('(')).trim();

function registerFunction(env, { keyArgs, ...definition }) {
  const head = nameInSignature(definition.signature);
  const name = head.slice(head.lastIndexOf('.') + 1);
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
