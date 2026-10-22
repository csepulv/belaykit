// A rule's `then:` params, checked at load against the JSON Schema (draft 2020-12, what
// zod 4's toJSONSchema writes) its registered action declares. An action that declares
// none takes none, so a misspelled param can't reach an action as a missing one.
// A params schema is closed by default: one that doesn't say what to do with
// extra keys gets `unevaluatedProperties: false`, which in 2020-12 also counts the params
// that allOf, $ref or if/then allow. So a misspelled param is refused, however the
// schema was written. A schema that sets the rule itself is taken as written.
import { compileProblem, makeAjv } from './json-schema.js';

const SAYS_WHAT_EXTRA_KEYS_DO = ['additionalProperties', 'unevaluatedProperties'];

const closedByDefault = (schema) => (schema !== null && typeof schema === 'object' && !Array.isArray(schema)
  && !SAYS_WHAT_EXTRA_KEYS_DO.some((keyword) => keyword in schema)
  ? { ...schema, unevaluatedProperties: false }
  : schema);

// Each action's validator, compiled once per load; a schema that doesn't compile is a
// registry problem, reported once, and its action's params go unchecked.
export function compileParamsCheckers(actions) {
  const ajv = makeAjv({ allErrors: true });
  const errors = [];
  const checkers = new Map();
  for (const [name, action] of Object.entries(actions)) {
    if (action.params === undefined) continue;
    try {
      checkers.set(name, ajv.compile(closedByDefault(action.params)));
    } catch (error) {
      errors.push(`action "${name}" params: ${compileProblem(error)}`);
      checkers.set(name, null);
    }
  }
  return { checkers, errors };
}

// Keywords that describe a value without limiting it; any other beside `type: 'string'` (enum, pattern,
// minLength, format…) would be checked against the template's text, not the text it becomes.
const ANNOTATIONS = new Set(['type', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', '$comment']);

const isPlainString = (schema) => schema !== null && typeof schema === 'object' && schema.type === 'string'
  && Object.keys(schema).every((keyword) => ANNOTATIONS.has(keyword));

// The params each action templates, by action name (the valid ones only), and the registry's
// problems with them: a templated param must be a top-level param of the action's schema, and a
// plain string there. `templates` is read once, here (through a class's getter too); the provider
// fills from this, not from the entry.
export function compileTemplatedParams(actions) {
  const templated = new Map();
  const errors = [];
  const withProblems = new Set();
  for (const [name, { templates, params }] of Object.entries(actions)) {
    if (templates === undefined) continue;
    const problem = (message) => {
      errors.push(`action "${name}" templates: ${message}`);
      withProblems.add(name);
    };
    if (!Array.isArray(templates)) {
      problem('must be a list of param names');
      continue;
    }
    if (params === undefined) {
      problem('the action takes no params');
      continue;
    }
    const properties = params?.properties ?? {};
    const valid = new Set();
    const seen = new Set();
    for (const param of templates) {
      if (seen.has(param)) problem(`${JSON.stringify(param)} is listed twice`);
      else if (typeof param !== 'string' || !Object.hasOwn(properties, param)) problem(`${JSON.stringify(param)} isn't one of its params`);
      else if (!isPlainString(properties[param])) problem(`"${param}" must be a plain string in its params schema (type "string", with no enum, pattern or other limit on its value)`);
      else valid.add(param);
      seen.add(param);
    }
    templated.set(name, valid);
  }
  return { templated, withProblems, errors };
}

export function paramsProblems(actionName, params, checkers) {
  if (!checkers.has(actionName)) {
    const passed = Object.keys(params);
    return passed.length ? [`"${actionName}" takes no params, but the rule passes ${passed.map((key) => `"${key}"`).join(', ')}`] : [];
  }
  const validate = checkers.get(actionName);
  if (validate === null || validate(params)) return [];
  return validate.errors.map((error) => paramProblem(actionName, error));
}

function paramProblem(actionName, { instancePath, keyword, message, params }) {
  if (keyword === 'required' && instancePath === '') return `"${actionName}" needs param "${params.missingProperty}"`;
  if (keyword === 'additionalProperties' && instancePath === '') return `param "${params.additionalProperty}" isn't one "${actionName}" takes`;
  if (keyword === 'unevaluatedProperties' && instancePath === '') return `param "${params.unevaluatedProperty}" isn't one "${actionName}" takes`;
  const where = instancePath === '' ? 'params' : `param "${instancePath.split('/').slice(1).join('.')}"`;
  if (keyword === 'additionalProperties') return `${where} has no key "${params.additionalProperty}"`;
  if (keyword === 'enum') return `${where} must be one of ${params.allowedValues.join(', ')}`;
  return `${where} ${message}`;
}
