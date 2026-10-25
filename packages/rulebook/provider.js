// A loaded rulebook as a BelayKit ChoiceProvider; compose it with hand-coded providers
// via BelayKit's chain(). The rulebook declares what the provider returns; the Decider
// executes it.
//
// Presence model (since 0.2): a key a section declares in `needs` is gathered when it is
// present in the working set. A producer may return null ("looked, found nothing"), which is a
// value and counts as gathered; it may not return undefined, which would read as absent.
// BelayKit assumes no terminal field: an agent initializes whatever it finishes on, like any
// other key.
import { always } from '@belaykit/core';
import { parseTemplate } from './templates.js';

// Present as cel-js's has() reads it: an own key, not holding undefined. The one test of "gathered".
export const isPresent = (ws, key) => Object.hasOwn(ws, key) && ws[key] !== undefined;

// A needs key already present would count as gathered, so its producer would never run.
export function initialWorkingSet(loaded, initial = {}) {
  const present = loaded.declaredKeys.find((key) => isPresent(initial, key));
  if (present !== undefined) throw new TypeError(`initialize: "${present}" is a needs key; its producer sets it`);
  return { ...initial };
}

export function rulebookProvider(loaded, registry, deps = {}) {
  // A non-boolean result is an authoring error, never a "no match": it fails the run.
  // cel-js's message adds an excerpt of the source after its first line; the run's message keeps the first.
  const holds = (expression, variables, environment = loaded.env) => {
    let result;
    try {
      result = environment.evaluate(expression, variables);
    } catch (error) {
      throw new Error(error.message.split('\n')[0], { cause: error });
    }
    if (typeof result !== 'boolean') throw new TypeError(`when evaluated to ${celTypeOf(result)}, expected a boolean`);
    return result;
  };
  // The action's guard comes first (since 0.2): when it's false the rule doesn't match, and its
  // `when` and selection aren't evaluated, so a guard such as has(ws.x) protects them.
  const matchRule = (rule, current) => {
    if (!guardHolds(rule.action, loaded.guards.get(rule.action), current, loaded.env)) return { matched: false, detail: { guard: false } };
    return rule.selectFirst ? selectFirstMatch(rule, current, holds) : { matched: holds(rule.when, { ws: current }) };
  };

  return async (ws) => {
    const section = loaded.sections.find((candidate) => holdsIn(candidate, ws, holds));
    if (!section) return null;

    const missing = Object.entries(section.needs).filter(([key]) => !isPresent(ws, key));
    if (missing.length > 0) {
      return { name: section.name, mode: 'all', choices: missing.map(([key, producer]) => gatherChoice(key, producer, registry.producers[producer], deps)) };
    }
    // A gather-only section claims the working set only while it is gathering.
    if (section.rules.length === 0) return null;
    return {
      name: section.name,
      mode: section.hitPolicy.toLowerCase(),
      choices: section.rules.map((rule) => ({
        name: rule.id,
        ...(rule.why !== null && { why: rule.why }),
        criteria: async (current) => matchRule(rule, current),
        actions: [async (current, match) => {
          assertGuardStillHolds(rule.action, loaded.guards.get(rule.action), current, loaded.env);
          return registry.actions[rule.action].run(current, {
            params: filledParams(rule, loaded.templated.get(rule.action), { ws: current, ...selectedBinding(match) }, loaded.env),
            deps,
            ...(match.data?.selected && { selected: match.data.selected }),
          });
        }],
      })),
    };
  };
}

const selectedBinding = (match) => (match.data?.selected ? { [match.data.selected.name]: match.data.selected.item } : {});

// The rule's params with each templated one filled from the case, just before its action runs,
// frozen like the rule's own (which keep their template text). A placeholder whose value can't
// become text throws, so the run fails naming the rule (the core adds it), the param and the placeholder.
// `templated` is the action's templated params as the loader read them (load.js).
function filledParams(rule, templated = new Set(), variables, rulebookEnv) {
  const toFill = [...templated].filter((param) => Object.hasOwn(rule.params, param));
  if (toFill.length === 0) return rule.params;
  const environment = rule.selectFirst?.env ?? rulebookEnv;
  const filled = { ...rule.params };
  for (const param of toFill) {
    // A placeholder that calls a macro runs its expansion (load.js).
    filled[param] = parseTemplate(rule.params[param]).parts
      .map((part) => ('text' in part ? part.text
        : placeholderText(param, { ...part, expression: rule.placeholders.get(part.expression) ?? part.expression }, environment, variables)))
      .join('');
  }
  return Object.freeze(filled);
}

function placeholderText(param, { expression, source }, environment, variables) {
  const where = `param "${param}" placeholder ${source}`;
  let value;
  try {
    value = environment.evaluate(expression, variables);
  } catch (error) {
    throw new Error(`${where}: ${error.message.split('\n')[0]}`, { cause: error });
  }
  if (['string', 'number', 'bigint', 'boolean'].includes(typeof value)) return String(value);
  throw new TypeError(`${where}: evaluated to ${kindOf(value)}, expected a string, number or boolean`);
}

// What a value that can't be text is, in CEL's terms where cel-js has a class for it.
const CEL_CLASSES = { UnsignedInt: 'a uint', Date: 'a timestamp', Duration: 'a duration', Type: 'a type', Map: 'a map', Set: 'a Set' };

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Uint8Array) return 'bytes';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return 'a map';
  return CEL_CLASSES[value.constructor?.name] ?? `a ${value.constructor?.name ?? 'object'}`;
}

// The first item, in list order, for which the rule's `when` holds with the item bound.
// The action gets the item and its index; the trace gets the index alone (`detail`).
function selectFirstMatch(rule, ws, holds) {
  const { name, expression, env } = rule.selectFirst;
  const items = env.evaluate(expression, { ws });
  if (!Array.isArray(items)) throw new TypeError(`selectFirst evaluated to ${celTypeOf(items)}, expected a list`);
  const index = items.findIndex((item, position) => holdsFor(item, position));
  function holdsFor(item, position) {
    try {
      return holds(rule.when, { ws, [name]: item }, env);
    } catch (error) {
      throw new Error(`${name} = item ${position}: ${error.message.split('\n')[0]}`, { cause: error });
    }
  }
  if (index === -1) return { matched: false };
  return { matched: true, data: { selected: { name, item: items[index], index } }, detail: { [name]: index } };
}

// An action without a guard always holds. A guard that throws or isn't a boolean fails the run, as a
// `when` does: false is the only "no".
function guardHolds(action, guard, ws, env) {
  if (guard === undefined) return true;
  const where = `action "${action}" guard`;
  let result;
  try {
    result = env.evaluate(guard, { ws });
  } catch (error) {
    throw new Error(`${where}: ${error.message.split('\n')[0]}`, { cause: error });
  }
  if (typeof result !== 'boolean') throw new TypeError(`${where}: evaluated to ${celTypeOf(result)}, expected a boolean`);
  return result;
}

// The core selects every rule of an ALL section before any action runs, so an earlier action can make
// a later guard false. Checked again just before the action:
// one that no longer holds fails the run, so a rulebook never runs an action whose guard is false.
// (Skipping instead would leave the rule recorded as fired.)
function assertGuardStillHolds(action, guard, ws, env) {
  if (!guardHolds(action, guard, ws, env)) {
    throw new Error(`action "${action}" guard no longer holds; an earlier action in this iteration changed ws`);
  }
}

function holdsIn(section, ws, holds) {
  try {
    return holds(section.when, { ws });
  } catch (error) {
    throw new Error(`section "${section.name}" when failed: ${error.message}`, { cause: error });
  }
}

// The CEL name of a value's type, for error messages.
function celTypeOf(value) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return 'double';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Uint8Array) return 'bytes';
  if (typeof value === 'object') return 'map';
  return typeof value;
}

const gatherChoice = (key, producerName, producer, deps) => ({
  name: `gather ${key}`,
  criteria: always,
  actions: [async (ws) => {
    const value = await producer.run(ws, deps);
    if (value === undefined) throw new TypeError(`producer "${producerName}" returned undefined for "${key}"; return null for found nothing`);
    ws[key] = value;
  }],
});
