// A loaded rulebook as a BelayKit ChoiceProvider; compose it with hand-coded providers
// via BelayKit's chain(). The rulebook declares what the provider returns; the Decider
// executes it.
//
// Presence model: every key a section declares in `needs` starts null; `ws.gathered`
// lists the keys whose producers have run. A producer may legitimately write null
// ("looked, found nothing") and still count as gathered. BelayKit assumes no terminal
// field: an agent initializes whatever it finishes on, like any other key.
import { always } from '@belaykit/core';

export function initialWorkingSet(loaded, initial) {
  const declared = Object.fromEntries(loaded.declaredKeys.map((key) => [key, null]));
  return { ...initial, ...declared, gathered: [] };
}

export function rulebookProvider(loaded, registry, deps = {}) {
  // A non-boolean result is an authoring error, never a "no match": it fails the run.
  const holds = (expression, variables, environment = loaded.env) => {
    const result = environment.evaluate(expression, variables);
    if (typeof result !== 'boolean') throw new TypeError(`when evaluated to ${celTypeOf(result)}, expected a boolean`);
    return result;
  };
  const matchRule = (rule, current) =>
    (rule.selectFirst ? selectFirstMatch(rule, current, holds) : { matched: holds(rule.when, { ws: current }) });

  return async (ws) => {
    const section = loaded.sections.find((candidate) => holdsIn(candidate, ws, holds));
    if (!section) return null;

    const missing = Object.entries(section.needs).filter(([key]) => !ws.gathered.includes(key));
    if (missing.length > 0) {
      return { name: section.name, mode: 'all', choices: missing.map(([key, producer]) => gatherChoice(key, registry.producers[producer], deps)) };
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
        actions: [async (current, match) => registry.actions[rule.action].run(current, {
          params: rule.params,
          deps,
          ...(match.data?.selected && { selected: match.data.selected }),
        })],
      })),
    };
  };
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

const gatherChoice = (key, producer, deps) => ({
  name: `gather ${key}`,
  criteria: always,
  actions: [async (ws) => {
    ws[key] = await producer.run(ws, deps);
    ws.gathered = [...ws.gathered, key];
  }],
});
