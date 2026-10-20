// JSON Schema as the registry uses it, for params and shapes: draft 2020-12 (what zod 4's
// toJSONSchema writes), compiled with ajv. Unknown keywords are allowed, since zod copies
// every `.meta()` key into the schema, and so are tuples without an item count.
import Ajv2020 from 'ajv/dist/2020.js';

export const makeAjv = (options = {}) => new Ajv2020({ strict: false, ...options });

// A schema that won't compile, in the registry's words: another draft named as such, and
// ajv's `data/properties/a/type` path written as `properties.a.type`.
export function compileProblem(error) {
  const message = error.message.split('\n')[0];
  if (/no schema with key or ref "https?:\/\/json-schema\.org\//.test(message)) return 'must be JSON Schema draft 2020-12 (or have no $schema)';
  return message.replaceAll(/\bdata((?:\/[^\s/,]+)*)/g, (_whole, path) => (path ? path.slice(1).replaceAll('/', '.') : 'the schema'));
}
