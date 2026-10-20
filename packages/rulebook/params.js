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
