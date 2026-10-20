// Shapes: a JSON Schema per working-set key (draft 2020-12, what zod 4's toJSONSchema
// writes). At load, every field path a rulebook reads is followed through them, from
// ws.<key>, from a selectFirst binding, and from a macro's variable, so a misspelled field
// is a load error. Checking stops where a shape stops saying: an open object, a key
// without a shape, a non-local $ref.
import { compileProblem, makeAjv } from './json-schema.js';

// Macros that bind a variable to each item of their receiver: `list.exists(x, …)`.
const BINDING_MACROS = new Set(['all', 'exists', 'exists_one', 'map', 'filter']);
const OPEN = Symbol('open');

// The registry's shapes, as checked: a shape must be for a declared key and must compile.
export function compileShapes(shapes = {}, knownKeys) {
  if (shapes === null || typeof shapes !== 'object' || Array.isArray(shapes)) {
    return { shapes: new Map(), errors: ['shapes: must be an object of JSON Schemas, one per ws key'] };
  }
  const ajv = makeAjv();
  const errors = [];
  const compiled = new Map();
  for (const [key, schema] of Object.entries(shapes)) {
    if (!knownKeys.has(key)) {
      errors.push(`shapes "${key}": no initial key, needs key or writes declares that key`);
      continue;
    }
    try {
      ajv.compile(schema);
      compiled.set(key, { schema, root: schema });
    } catch (error) {
      errors.push(`shapes "${key}": ${compileProblem(error)}`);
    }
  }
  return { shapes: compiled, errors };
}

// What a selectFirst binding stands for: an item of the list its expression reads.
export function bindingFor(name, expressionAst, shapes) {
  const list = resolve(expressionAst, { shapes, scope: new Map(), errors: [] });
  return itemBinding(name, list);
}

// Every misspelled field an expression reads, given the bindings in scope.
export function shapeErrors(ast, { shapes, bindings = new Map(), keyArgsByName = new Map() }) {
  const errors = [];
  visit(ast, { shapes, scope: bindings, errors, keyArgsByName });
  return errors;
}

function visit(node, context) {
  if (node.op === '.' || node.op === '[]') {
    resolve(node, context);
    return;
  }
  if (node.op === 'rcall' && BINDING_MACROS.has(node.args[0]) && node.args[2]?.[0]?.op === 'id') {
    visitMacro(node, context);
    return;
  }
  if (node.op === 'call' && context.keyArgsByName.has(node.args[0])) checkKeyArg(node, context);
  for (const child of childNodesOf(node.args)) visit(child, context);
}

// `list.exists(s, body)`: `s` is an item of `list` inside the body, and nowhere else. (cel-js
// has no two-variable form, `list.all(i, s, …)`: it reports `i` as an unknown variable.)
function visitMacro(node, context) {
  const [, receiver, [variable, ...bodies]] = node.args;
  const list = resolve(receiver, context);
  const scope = new Map(context.scope).set(variable.args, itemBinding(variable.args, list));
  for (const body of bodies) visit(body, { ...context, scope });
}

// helper(ws.write, "action") with keyArgs reads ws.write.action.
function checkKeyArg(node, context) {
  const { key, in: container } = context.keyArgsByName.get(node.args[0]);
  const argumentNodes = node.args[1];
  const keyName = argumentNodes[key] ? literalStringOf(argumentNodes[key]) : null;
  if (keyName === null || !argumentNodes[container]) return;
  step(resolve(argumentNodes[container], context), keyName, context);
}

// What an expression node reads: `{ shape, label }`, the ws root, or null when unchecked.
function resolve(node, context) {
  if (node.op === 'id') {
    if (node.args === 'ws') return 'ws';
    return context.scope.get(node.args) ?? null;
  }
  if (node.op === '.') return step(resolve(node.args[0], context), node.args[1], context);
  if (node.op === '[]') {
    const base = resolve(node.args[0], context);
    const name = literalStringOf(node.args[1]);
    if (name !== null) return step(base, name, context);
    visit(node.args[1], context);
    return base && base !== 'ws' ? itemOf(base, literalIndexOf(node.args[1])) : null;
  }
  visit(node, context);
  return null;
}

function step(base, name, context) {
  if (base === null) return null;
  if (base === 'ws') return context.shapes.has(name) ? { shape: context.shapes.get(name), label: `ws.${name}` } : null;
  const field = fieldOf(base.shape, name);
  if (field === OPEN) return null;
  if (field === null) {
    const where = `${base.label}${base.origin ? ` (${base.origin})` : ''}${isList(base.shape) ? ' (a list)' : ''}`;
    context.errors.push(`unknown field "${name}" on ${where}`);
    return null;
  }
  return { shape: field, label: `${base.label}.${name}` };
}

const itemBinding = (name, list) => {
  const item = list && list !== 'ws' ? itemOf(list) : null;
  return item && { ...item, label: name, origin: `an item of ${list.label}` };
};

// An item of a list: at a literal index, a tuple's own prefixItems entry when it has one.
const itemOf = (base, index = null) => {
  const items = itemsOf(base.shape, index);
  return items === OPEN ? null : { shape: items, label: `${base.label}[${index ?? ''}]` };
};

// The ways a schema may be: its own structure and each branch of anyOf, oneOf and allOf,
// with `$ref`s followed and `null` branches left out (reading a field of null fails at run
// time whatever the shape says). A schema reached again through its own branches stops the
// check, as a self-reference would otherwise never end.
function variantsOf({ schema, root }, seen = new Set()) {
  const resolved = deref(schema, root);
  if (resolved === OPEN || resolved === true || resolved === undefined) return [OPEN];
  if (resolved === false) return [];
  if (seen.has(resolved)) return [OPEN];
  const inside = new Set(seen).add(resolved);
  const branches = ['anyOf', 'oneOf', 'allOf'].flatMap((keyword) => resolved[keyword] ?? []);
  const own = kindOf(resolved);
  return [
    ...(own === 'none' && branches.length ? [] : own === 'null' ? [] : [{ schema: resolved, root, kind: own }]),
    ...branches.flatMap((branch) => variantsOf({ schema: branch, root }, inside)),
  ];
}

function kindOf(schema) {
  const types = [schema.type].flat().filter(Boolean);
  if (types.length === 1 && types[0] === 'null') return 'null';
  if (schema.properties || schema.additionalProperties !== undefined || schema.patternProperties || types.includes('object')) return 'object';
  if (schema.items || schema.prefixItems || types.includes('array')) return 'array';
  return types.length ? 'scalar' : 'none';
}

// A field of a shape: its shape, OPEN when the shape doesn't say, or null when no variant has it.
function fieldOf(shape, name) {
  const variants = variantsOf(shape);
  if (variants.length === 0) return OPEN;
  const fields = [];
  for (const variant of variants) {
    if (variant === OPEN || variant.kind === 'none') return OPEN;
    if (variant.kind !== 'object') continue;
    const field = objectField(variant.schema, name);
    if (field === OPEN) return OPEN;
    if (field !== null) fields.push(field);
  }
  if (fields.length === 0) return null;
  return { schema: fields.length === 1 ? fields[0] : { anyOf: fields }, root: shape.root };
}

function objectField(schema, name) {
  if (schema.properties && Object.hasOwn(schema.properties, name)) return schema.properties[name];
  const pattern = Object.entries(schema.patternProperties ?? {}).find(([source]) => new RegExp(source, 'u').test(name));
  if (pattern) return pattern[1];
  // Not unevaluatedProperties: what it allows depends on if/then, dependentSchemas and the
  // like, which the walk doesn't follow, so it can't close an object here.
  if (schema.additionalProperties === false) return null;
  return schema.additionalProperties === undefined || schema.additionalProperties === true ? OPEN : schema.additionalProperties;
}

// A list's item at `index` (a number, or null for any item). A tuple's prefixItems describe
// their own indexes and `items` the rest, so any item of a tuple is any of them.
function itemsOf(shape, index = null) {
  const lists = variantsOf(shape).filter((variant) => variant === OPEN || variant.kind === 'array' || variant.kind === 'none');
  const items = lists.map((variant) => (variant === OPEN ? OPEN : itemSchemaOf(variant.schema, index)));
  if (items.length !== 1 || items[0] === OPEN) return OPEN;
  return { schema: items[0], root: shape.root };
}

function itemSchemaOf(schema, index) {
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  if (index !== null && index < prefix.length) return prefix[index];
  if (index === null && prefix.length) return schema.items ? { anyOf: [...prefix, schema.items] } : OPEN;
  return schema.items ?? OPEN;
}

const isList = (shape) => {
  const variants = variantsOf(shape);
  return variants.length > 0 && variants.every((variant) => variant !== OPEN && variant.kind === 'array');
};

// Only a local reference ('#/$defs/source') is followed; anything else stops the check.
function deref(schema, root, seen = new Set()) {
  if (schema === null || typeof schema !== 'object' || typeof schema.$ref !== 'string') return schema;
  if (!schema.$ref.startsWith('#') || seen.has(schema.$ref)) return OPEN;
  const target = schema.$ref.slice(1).split('/').slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), root);
  return target === undefined ? OPEN : deref(target, root, new Set(seen).add(schema.$ref));
}

const childNodesOf = (args) => {
  if (Array.isArray(args)) return args.flatMap(childNodesOf);
  return args !== null && typeof args === 'object' && 'op' in args ? [args] : [];
};

const literalStringOf = (node) => (node.op === 'value' && typeof node.args === 'string' ? node.args : null);
// CEL integers are BigInts.
const literalIndexOf = (node) => (node.op === 'value' && typeof node.args === 'bigint' ? Number(node.args) : null);
