// BelayKit's own CEL helpers for rulebooks, for the oddities of CEL: methods of one constant,
// `belaykit`, so a rule calls `belaykit.present(ws, "facts.recurrence")`. cel-js can't register a
// dotted function name, so the namespace is a registered type with a single constant of it.
export const NAMESPACE = 'belaykit';
export const NAMESPACE_TYPE = 'BelayKit';

class BelayKitHelpers {}

export const HELPERS = [
  {
    // The path is `dyn` so cel-js's check leaves it to the loader, which requires a string literal (load.js):
    // a path problem is then BelayKit's message alone, and never hides another call's overload failure.
    signature: `${NAMESPACE_TYPE}.present(dyn, dyn): bool`,
    description: 'True when every key on the path exists and the last value isn\'t null. A missing key, or a null on the '
      + 'way, is false; a step into a value that isn\'t a map, and an empty path or segment, are errors. `has()` is true '
      + 'for a key holding null.',
    params: [
      { name: 'container', description: 'A map to read from: ws, a selectFirst binding or a macro variable' },
      { name: 'path', description: 'Keys joined by dots, such as "facts.recurrence": a string literal, checked at load like the fields it reads' },
    ],
    handler: (_helpers, container, path) => present(container, path),
  },
];

// 'BelayKit.present(dyn, dyn): bool' -> 'present'.
export const HELPER_NAMES = new Set(HELPERS.map(({ signature }) => signature.slice(signature.indexOf('.') + 1, signature.indexOf('('))));

// The helpers that read a path, and which arguments are the container and the path. The loader checks
// the path like the field access it stands for (load.js, shapes.js).
const PATH_ARGUMENTS = new Map([['present', { container: 0, path: 1 }]]);

// For a call to a helper that reads a path (`belaykit.present(ws, "a.b")`, a syntax-tree node):
// `{ name, container, path }`, the argument nodes; null for any other node.
export function helperPathCallOf(node) {
  if (node.op !== 'rcall' || node.args[1]?.op !== 'id' || node.args[1].args !== NAMESPACE) return null;
  const name = node.args[0];
  const positions = PATH_ARGUMENTS.get(name);
  const argumentNodes = node.args[2];
  if (!positions || !argumentNodes[positions.container] || !argumentNodes[positions.path]) return null;
  return { name, container: argumentNodes[positions.container], path: argumentNodes[positions.path] };
}

export function registerHelpers(env) {
  env.registerType(NAMESPACE_TYPE, BelayKitHelpers).registerConstant(NAMESPACE, NAMESPACE_TYPE, new BelayKitHelpers());
  for (const definition of HELPERS) env.registerFunction(definition);
}

// A problem with a helper's path, in the same words at load and at run time:
// 'belaykit.present "facts.recurence": unknown field "recurence" on ws.facts'.
export const pathProblem = (name, path, problem) => `${NAMESPACE}.${name} ${JSON.stringify(path)}: ${problem}`;

export const EMPTY_SEGMENT = 'a path is keys joined by dots, such as "facts.recurrence"';

// Reads the path itself, one key at a time, so a missing key never reaches CEL's `No such key`.
function present(container, path) {
  const fail = (problem) => { throw new Error(pathProblem('present', path, problem)); };
  const keys = path.split('.');
  if (keys.includes('')) fail(EMPTY_SEGMENT);
  if (isAbsent(container)) return false;
  if (!isMap(container)) fail(`the container is ${kindOf(container)}, not a map`);
  let value = container;
  for (const [index, key] of keys.entries()) {
    if (!isMap(value)) fail(`"${keys[index - 1]}" is ${kindOf(value)}, not a map`);
    value = valueAt(value, key);
    if (isAbsent(value)) return false;
  }
  return true;
}

// A key holding undefined counts as missing, as it does for cel-js's `has()`.
const isAbsent = (value) => value === null || value === undefined;

// The maps cel-js reads as CEL maps: plain objects (CEL map literals and the working set's data) and the Maps an
// action may write. Any other object (a Date, a Set, a class instance) isn't one.
const isMap = (value) => value instanceof Map || isPlainObject(value);

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// Own keys only, so a path like "toString" isn't found on every object.
const valueAt = (map, key) => {
  if (map instanceof Map) return map.get(key);
  return Object.hasOwn(map, key) ? map[key] : undefined;
};

function kindOf(value) {
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Uint8Array) return 'bytes';
  if (typeof value === 'bigint' || typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'object') return `a ${value.constructor?.name ?? 'object'}`;
  return `a ${typeof value}`;
}
