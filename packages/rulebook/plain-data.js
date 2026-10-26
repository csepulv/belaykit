// Values in the working set, as data (since 0.4). A copy (decide.js) takes plain data: objects, lists, Map, Set,
// Date, RegExp, ArrayBuffer and typed arrays, which structuredClone copies with their class (some of their keys aside:
// `copyLossOf`); anything else with a prototype of its own (a class instance, an Error, a boxed primitive) is refused
// rather than copied with its class dropped. cel-js can't read a class instance either (provider.js). These find such
// a value and name where it is.

// Exact prototypes: a subclass (a Buffer is a Uint8Array) would come back as its base class.
const TYPED_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView];
const PLAIN_PROTOTYPES = new Set([Object.prototype, null, Array.prototype, Map.prototype, Set.prototype, Date.prototype,
  RegExp.prototype, ArrayBuffer.prototype, ...TYPED_ARRAYS.map((type) => type.prototype)]);

export const isPlainData = (value) => value === null || typeof value !== 'object' || PLAIN_PROTOTYPES.has(Object.getPrototypeOf(value));

// What structuredClone loses of a plain value without an error, as what the value is or has
// (`has a symbol key, Symbol(tag), which a copy leaves out`), or undefined (for `onCopyLoss: 'fail'`, since 0.4): a
// symbol key, a key that isn't enumerable, any key of its own on a built-in other than an object or a list (a Map's, a
// Date's), and a RegExp's lastIndex other than 0, which a copy resets. Neither reads a getter.
export function copyLossOf(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const key = Reflect.ownKeys(value).find((own) => !isKeptByCopy(value, own));
  if (key === undefined) {
    return value instanceof RegExp && value.lastIndex !== 0 ? `is a RegExp whose lastIndex is ${value.lastIndex}, which a copy resets to 0` : undefined;
  }
  if (typeof key === 'symbol') return `has a symbol key, ${String(key)}, which a copy leaves out`;
  if (!Object.prototype.propertyIsEnumerable.call(value, key)) return `has a key that isn't enumerable, ${JSON.stringify(key)}, which a copy leaves out`;
  const { name } = Object.getPrototypeOf(value).constructor;
  // The names here are the built-ins above: an ArrayBuffer, an Int8Array, a Uint8Array.
  return `is ${/^[AEIO]/.test(name) ? 'an' : 'a'} ${name} with a key of its own, ${JSON.stringify(key)}, which a copy leaves out`;
}

// A copy keeps an object's and a list's enumerable string keys, a list's length, a RegExp's lastIndex (the key: its
// value comes back 0) and a typed array's items, and nothing else of a value's own.
function isKeptByCopy(value, key) {
  if (typeof key === 'symbol') return false;
  if ((Array.isArray(value) && key === 'length') || (value instanceof RegExp && key === 'lastIndex')) return true;
  if (isTypedArrayItem(value, key)) return true;
  const isRecord = [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value));
  return isRecord && Object.prototype.propertyIsEnumerable.call(value, key);
}

// An item's key is its index as a number writes it (`"1"`, not `"01"`); a DataView has no items.
const isTypedArrayItem = (value, key) => ArrayBuffer.isView(value) && !(value instanceof DataView)
  && String(Number(key)) === key && Number(key) < value.length;

// What a value is, in a message: `an instance of Memo`, `a function`.
export const kindOfValue = (value) => (value !== null && typeof value === 'object'
  ? `an instance of ${value.constructor?.name || 'an unnamed class'}`
  : `a ${typeof value}`);

// The values inside `value` (itself included) for which `isMatch` holds, each with its path (`ws.facts.items[0]`),
// depth first, at most `limit`. It reads what structuredClone reads: an object's and a list's enumerable own keys
// (a getter is called, and may throw), a Map's keys and values, a Set's items; each object once. It walks with its
// own stack, so a value nested however deep can't overflow it.
export function matchesIn(value, path, isMatch, limit = Infinity) {
  const found = [];
  const seen = new Set();
  const pending = [[value, path]];
  while (pending.length > 0 && found.length < limit) {
    const [current, currentPath] = pending.pop();
    if (isMatch(current)) {
      found.push({ value: current, path: currentPath });
      continue;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    // In reverse, so the first child is visited first; one at a time, since a spread of a long list overflows too.
    const children = childrenOf(current, currentPath);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return found;
}

function childrenOf(value, path) {
  if (value instanceof Map) {
    return [...value].flatMap(([key, item]) => [[key, `${path} (a Map key)`], [item, `${path}.get(${mapKeyText(key)})`]]);
  }
  if (value instanceof Set) return [...value].map((item) => [item, `${path} (a Set item)`]);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return [];
  return Object.keys(value).map((key) => [value[key], `${path}${keyText(value, key)}`]);
}

const keyText = (value, key) => {
  if (Array.isArray(value) && /^\d+$/.test(key)) return `[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
};

const mapKeyText = (key) => (key !== null && typeof key === 'object' ? '<an object key>' : JSON.stringify(String(key)));
