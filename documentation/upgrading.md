---
title: Upgrading
---

# Upgrading

What changes when you move to a new version of BelayKit, and what to do about it: one section per version, newest
first. [CHANGELOG.md](../CHANGELOG.md) lists every change; this page covers the ones that can stop an agent or a
rulebook that worked before. Each example runs on the current version, so a message a later release reworded shows
its new wording, in the older sections too.

## From 0.3 to 0.4

Upgrade the packages together, as for 0.3: `@belaykit/rulebook` 0.4 takes `@belaykit/core` 0.4 as its peer.

```bash
npm install @belaykit/core@^0.4.0 @belaykit/rulebook@^0.4.0
npm install belaykit@^0.4.0 @belaykit/rulebook@^0.4.0     # if you use the core as belaykit
```

A rulebook that worked with 0.3 loads unchanged. What changed is what `rulebook.decide` returns, which matters to code
that reads a decision, and in what a test or a type might compare:

| Change | What you see | What to do |
| --- | --- | --- |
| Outputs are copies | changing `decision.outputs.x` no longer changes the working set's `x` | read the result from the decision |
| A value that can't be copied fails the decision | an output holding a class instance (anywhere inside it, built-ins such as `Error`, `URL` and `Buffer` included), a function or a symbol, which 0.3 returned, now makes the decision `failed`: `decide: output "x" can't be copied (…)` | keep outputs to plain data: objects, lists, strings, numbers (`BigInt` included), booleans, `null`, `Map`, `Set`, `Date`, `RegExp`, `ArrayBuffer`, typed arrays; keep a class's behavior in code |
| A copy leaves some keys out | a symbol key, a key that isn't enumerable, or a built-in's own key (a `Map`'s, `Set`'s, `Date`'s, `RegExp`'s, a buffer's), which 0.3 returned with the value, is missing from the copy, and a `RegExp`'s `lastIndex` comes back 0 | keep it as a plain key; or pass `decide(initial, { onCopyLoss: 'fail' })` to have such a loss fail the decision, naming it |
| An output no rule decided fails the decision | an output written by something other than a rule's action (a producer writing into `ws` beyond the key it gathers, say), which 0.3 accepted, now makes the decision `failed`: `decide: output "x" wasn't set by a rule's action (…)`; on a `no_match` run with such an output present too | have a rule's action write it |
| A value CEL can't read is named | a run that failed with `Unsupported type: Site` now says `ws.site is an instance of Site, which CEL can't read (…)` | update a test that matches the old text |
| A failing `selectFirst` list is named, in one line | a run whose `selectFirst` expression failed, which 0.3 reported with cel-js's message and its source excerpt, now says `criteria failed: selectFirst: No such key: items` | update a test that matches the old text |
| Every decision has `evidence`, and a completed one `decidedBy` | a test comparing a whole decision with `toEqual` or `deepStrictEqual` sees the new keys | compare the keys you mean (`decision.outputs`), or add the new ones |
| The TypeScript `Decision` type has them too | a hand-built `Decision` (in a test, a fixture or a stub) no longer type-checks without `evidence`, and a completed one without `decidedBy` | add `evidence: {}` and `decidedBy: {}` |
| `RulebookTextOptions` is a type, not an interface | an `interface X extends RulebookTextOptions` no longer compiles | use `type X = RulebookTextOptions & { … }` |
| The no-folder problem and the option list name `imports` | `…; pass { baseDir }` reads `…; pass { baseDir } or { imports }`, and `(options: baseDir)` reads `(options: baseDir, imports)` (for `checkMacros`, `(options: baseDir, imports, path)`) | update a test that matches the old text |

The first three, and the `selectFirst` message, as 0.4 reports them:

```js run
import { Rulebook } from '@belaykit/rulebook';

const tag = Symbol('tag');
const registry = {
  producers: {},
  actions: {
    settle: { writes: ['routing'], run: async (ws, { deps }) => { ws.routing = { route: 'hold' }; deps.seen = ws; } },
    settle_with_code: { writes: ['routing'], run: async (ws) => { ws.routing = { route: 'hold', explain: () => 'held' }; } },
    settle_with_tag: { writes: ['routing'], run: async (ws) => { ws.routing = { route: 'hold', [tag]: 'internal' }; } },
  },
  initialKeys: ['items'],
};
const rulebook = (action) => `
version: 1
outputs: [routing]
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - when: "true"
        then: { action: ${action} }
`;
const decideWith = (action, options) => Rulebook.fromText(rulebook(action), registry).decide({}, options);

const deps = {};
const decision = await decideWith('settle', { deps });
console.log(decision.outputs.routing, 'is the working set\'s:', decision.outputs.routing === deps.seen.routing);
console.log((await decideWith('settle_with_code')).error);
console.log((await decideWith('settle_with_tag')).outputs.routing);
console.log((await decideWith('settle_with_tag', { onCopyLoss: 'fail' })).error);

const selecting = Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: decide
    when: '!has(ws.routing)'
    exhaustive: false
    rules:
      - selectFirst: { item: ws.items }
        when: item == "x"
        then: { action: settle }
`, registry);
console.log((await selecting.decide({})).error);
```

```text output
{ route: 'hold' } is the working set's: false
decide: output "routing" can't be copied (() => 'held' could not be cloned.)
{ route: 'hold' }
decide: output "routing" can't be copied (routing has a symbol key, Symbol(tag), which a copy leaves out)
decide/decide#1 criteria failed: selectFirst: No such key: items
```

What's new is `decidedBy` and `evidence`; see [Deciding with a rulebook](rulebooks.md#deciding-with-a-rulebook).

## From 0.2 to 0.3

Upgrade the packages together: `@belaykit/rulebook` 0.3 takes `@belaykit/core` 0.3 as its peer. A range written for
0.2 (`^0.2.0`) doesn't reach 0.3, so name the new one:

```bash
npm install @belaykit/core@^0.3.0 @belaykit/rulebook@^0.3.0
npm install belaykit@^0.3.0 @belaykit/rulebook@^0.3.0     # if you use the core as belaykit
```

A rulebook, a registry or an agent that worked with 0.2 works with 0.3 unchanged, unless it passes a third argument
to `Rulebook.fromText` or `Rulebook.check`. Two texts changed wording, which matters only to a check that compares
them:

| Change | What you see | What to do |
| --- | --- | --- |
| `Rulebook.fromText` and `Rulebook.check` take options as a third argument | a `TypeError` for a value that isn't an object (`null` and `undefined` are fine), or a key other than `baseDir`, where a third argument was ignored | pass only `{ baseDir }`, or nothing |
| "Macro" now also names a rulebook macro, so CEL's own are called CEL macros | the problem `macro variable "belaykit" is reserved…` reads `CEL macro variable "belaykit" is reserved…` | update a test that matches the old text |
| The same wording in `belaykit.present`'s description | a function reference generated again differs in one line, its `container` row ("a CEL macro variable") | regenerate a committed reference |

The first two, as 0.3 reports them:

```js run
import { Rulebook } from '@belaykit/rulebook';

const registry = {
  producers: {},
  actions: { settle: { writes: ['routing'], run: async () => {} } },
  initialKeys: ['items', 'routing'],
};
const rulebook = `
version: 1
sections:
  - name: decide
    when: ws.items.exists(belaykit, belaykit == "x")
    exhaustive: false
    rules:
      - when: "true"
        then: { action: settle }
`;

for (const options of ['.', { basedir: '.' }]) {
  try { Rulebook.check(rulebook, registry, options); } catch (error) { console.log(`${error.name}: ${error.message}`); }
}
console.log(Rulebook.check(rulebook, registry).join('\n'));
```

```text output
TypeError: Rulebook.check: options must be an object, such as { baseDir }
TypeError: Rulebook.check: unknown option "basedir" (options: baseDir, imports)
section "decide" when: CEL macro variable "belaykit" is reserved for BelayKit's helpers
```

What's new is [macros](rulebooks.md#macros), and they apply only to a rulebook that imports a macro file.

## From 0.1 to 0.2

Upgrade the packages together: `@belaykit/rulebook` 0.2 takes `@belaykit/core` 0.2 as its peer.

```bash
npm install @belaykit/core@^0.2.0 @belaykit/rulebook@^0.2.0
npm install belaykit@^0.2.0 @belaykit/rulebook@^0.2.0     # if you use the core as belaykit
```

Most of what follows shows up when a rulebook loads, so `Rulebook.check` (or `npx belaykit-rulebook check`) on your
rulebooks finds it before anything runs. The rest shows up when a run starts or as it goes, and one change, in your
agent's own code, can pass silently ([below](#your-agents-own-code)).

| Change | What you see | What to do |
| --- | --- | --- |
| `ws.gathered` is gone | a load problem naming it; in JavaScript, `undefined` | test `has(ws.<key>)`; in JavaScript, `Object.hasOwn(ws, key)` |
| A `needs` key is absent until gathered, not `null` | `ws.<key> == null` fails the run; an initial working set that holds the key is refused; **a JavaScript test `ws.<key> !== null` is true at once** | write `!has(ws.<key>)`; leave the key out of the initial working set; in JavaScript, test presence |
| A `needs` key already present counts as gathered | its producer doesn't run | leave it out until the producer should run |
| A producer may not return `undefined` | the run fails, naming the producer | return `null` for "found nothing" |
| Every `FIRST` section says what happens when no rule holds | a load problem naming the section | end it with a `when: "true"` rule, or say `exhaustive: false` |
| Only the known keys on a registered action or producer | a load problem naming the key | pass what it needs (a client, a store) through `deps` |
| A brace in a param marks a placeholder | a load problem naming the param | list the param in the action's `templates`, or write `{{` and `}}` |
| A compared string must be one of the values a shape allows | a load problem naming the value | fix the typo, or the shape |
| `durationMs` left the default trace entry | the entry has no `durationMs` | read it in a tracer, from its second argument |
| `belaykit` is a reserved name | a load problem naming it | rename your binding, variable or function |
| The function reference lists BelayKit's helpers first | a committed reference differs | regenerate it (`belaykit-rulebook reference`) |
| TypeScript: `TraceEntry` has no `durationMs`, `WorkingSet` no `gathered` | a type error where you read them | as above: the tracer's context, and presence |

### Rulebooks that no longer load

A rulebook and registry written for 0.1, loaded by 0.2:

```js run
import { Rulebook } from '@belaykit/rulebook';

class Settle {
  constructor(store) { this.store = store; }
  writes = ['routing'];
  params = { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: false };
  async run(ws, { params }) { ws.routing = params.routing; }
}
const registry = {
  producers: { classify_item: { writes: ['classification'], run: async (ws, deps) => deps.classify(ws.item) } },
  actions: { settle: new Settle('db') },
  initialKeys: ['item', 'routing', 'ticket'],
  shapes: { ticket: { type: 'object', properties: { status: { enum: ['open', 'closed'] } }, additionalProperties: false } },
};

console.log(Rulebook.check(`
version: 1
sections:
  - name: gather
    when: '!("classification" in ws.gathered)'
    needs: { classification: classify_item }
  - name: decide
    when: ws.routing == null
    rules:
      - when: ws.classification.urgent == true && ws.ticket.status == "opne"
        then: { action: settle, routing: escalate }
`, registry).join('\n'));
```

```text output
action "settle": unknown key "store" (keys: writes, params, templates, guard, run; pass dependencies through deps)
section "gather" when: unknown ws field "gathered" (gone in 0.2: test has(ws.<key>) for a gathered key)
section "decide" rule 1 when: ws.ticket.status is compared with "opne", which its shape doesn't allow (open, closed)
section "decide": a FIRST section must end in a rule with when: "true" (without selectFirst), or say exhaustive: false
```

- **An entry's own keys.** A registered action may have only `writes`, `params`, `templates`, `guard` and `run`, and a
  producer only `writes` and `run`, for one made from a class too. A misspelled key would otherwise be ignored. Give
  the entry what it needs through `deps`, which reach every producer and action: `rules.provider(deps)`,
  `rules.decide(initial, { deps })`. (A class can also keep it in a private field, `#store`, which isn't a key.)
- **`ws.gathered`.** 0.1 kept a list of the keys whose producers had run; 0.2 has none. A `needs` key is gathered
  when it is present in the working set, so ask `has(ws.classification)`.
- **Compared values.** A string compared with a field whose shape lists its values (`enum`, `const`) must be one of
  them, so a typo is refused instead of making its rule never match.
- **When no rule holds.** A `FIRST` section with rules ends in a rule that always holds (`when: "true"`, without
  `selectFirst`, on an action without a [guard](rulebooks.md#guarded-actions)), or says `exhaustive: false` when it
  needs none: its `when` already ensures some rule holds, or a no-match should end the run
  ([When no rule holds](rulebooks.md#when-no-rule-holds)).

A brace in a param's text now marks a [placeholder](rulebooks.md#templated-params), so one in a param the action
doesn't template is refused rather than reaching the action as text:

```js run
import { Rulebook } from '@belaykit/rulebook';

const registry = {
  producers: {},
  actions: { settle: { writes: ['routing'], params: { type: 'object', properties: { routing: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false }, run: async () => {} } },
  initialKeys: ['item', 'routing'],
};

console.log(Rulebook.check(`
version: 1
sections:
  - name: decide
    when: ws.routing == null
    exhaustive: false
    rules:
      - when: "true"
        then: { action: settle, routing: hold, note: "{ws.item}" }
`, registry).join('\n'));
```

```text output
section "decide" rule 1: param "note" has a brace, but "settle" doesn't template "note"
```

List `note` in the action's `templates` if the rulebook should fill it from the case; write `{{` and `}}` for literal
braces.

The name `belaykit` belongs to BelayKit's own CEL helpers ([BelayKit's helpers](rulebooks.md#belaykits-helpers)), so a
`selectFirst` binding, a CEL macro's variable or a registered function can't take it, nor can a method on `dyn` that would
overlap a helper:

```js run
import { Rulebook } from '@belaykit/rulebook';

const registry = {
  producers: {},
  actions: { settle: { writes: ['routing'], run: async () => {} } },
  initialKeys: ['items', 'routing'],
  functions: [
    { signature: 'belaykit(string): bool', handler: () => true },
    { signature: 'dyn.present(dyn, dyn): bool', handler: () => true },
  ],
};

console.log(Rulebook.check(`
version: 1
sections:
  - name: decide
    when: ws.items.exists(belaykit, belaykit == "x")
    exhaustive: false
    rules:
      - selectFirst: { belaykit: ws.items }
        when: belaykit == "x"
        then: { action: settle }
`, registry).join('\n'));
```

```text output
function "belaykit": the name is reserved for BelayKit's helpers
function "dyn.present": a method on dyn named "present" would also apply to belaykit.present; rename it
section "decide" rule 1 selectFirst: binding "belaykit" is reserved for BelayKit's helpers
section "decide" when: CEL macro variable "belaykit" is reserved for BelayKit's helpers
```

### Runs that now fail

A `needs` key is absent until its section gathers it. 0.1 started it as `null`; 0.2 adds nothing to the initial
working set:

```js run
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const registry = {
  producers: { classify_item: { writes: ['classification'], run: async (ws, deps) => deps.classify(ws.item) } },
  actions: { settle: { writes: ['routing'], params: { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.routing = params.routing; } } },
  initialKeys: ['item', 'routing'],
};
const rulebook = (gatherWhen) => Rulebook.fromText(`
version: 1
sections:
  - name: gather
    when: ${JSON.stringify(gatherWhen)}
    needs: { classification: classify_item }
  - name: decide
    when: ws.routing == null
    rules:
      - when: "true"
        then: { action: settle, routing: hold }
`, registry);
// The run's status, and its error's first line when it failed.
const outcomeOf = async (rules, classify) => {
  const outcome = await new Agent({
    initializer: () => rules.initialize({ item: 'x', routing: null }),
    choiceProvider: rules.provider({ classify }),
    finishChecker: (ws) => ws.routing !== null,
  }).run();
  return outcome.error ? `${outcome.status}: ${outcome.error.message.split('\n')[0]}` : outcome.status;
};

const old = rulebook('ws.classification == null');
try { old.initialize({ item: 'x', routing: null, classification: null }); } catch (error) { console.log(error.message); }
console.log(await outcomeOf(old, async () => ({ urgent: false })));
const fixed = rulebook('!has(ws.classification)');
console.log(await outcomeOf(fixed, async () => undefined));
console.log(await outcomeOf(fixed, async () => null));
```

```text output
initialize: "classification" is a needs key; its producer sets it
failed: iteration 1 choiceProvider failed: section "gather" when failed: No such key: classification
failed: gather/gather classification action failed: producer "classify_item" returned undefined for "classification"; return null for found nothing
completed
```

- **Leave `needs` keys out of the initial working set,** `null` included: one that's there counts as gathered, so
  its producer would never run, and `initialize` refuses it.
- **Ask `!has(ws.<key>)`, not `ws.<key> == null`,** for "not gathered yet". Reading a key that isn't there fails the
  run.
- **A producer returns `null` for "found nothing"** (the last run above completes); `undefined`, a forgotten `return`
  say, fails the run, since the key would read as absent and be gathered again forever.
- **`rules.regather(ws, key)` removes the key** rather than setting it to `null`, so code that reads it afterwards finds
  it absent.
- **A `needs` key that something wrote before its section ran counts as gathered,** so its producer doesn't run. (0.1
  ran the producer anyway and overwrote the value.)
- **Fixtures written for 0.1** change the same way: their `initial` leaves out `needs` keys, and an `expect.result`
  that holds the whole working set (no finalizer) loses `gathered` and the `null` of a key never gathered.

### Your agent's own code

0.1's `initialize` added every `needs` key as `null`, and `gathered: []`, so code beside the rulebook often read them:
a finish checker, a chained code provider, a finalizer. In 0.2 neither is there until the key is gathered, and one
such test passes silently:

```js run
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const calls = [];
const registry = {
  producers: { classify_item: { writes: ['classification'], run: async (ws) => { calls.push(ws.item); return { urgent: false }; } } },
  actions: {},
  initialKeys: ['item'],
};
const rules = Rulebook.fromText(`
version: 1
sections:
  - name: gather
    when: '!has(ws.classification)'
    needs: { classification: classify_item }
`, registry);
const run = (finishChecker) => new Agent({ initializer: (item) => rules.initialize({ item }), choiceProvider: rules.provider(), finishChecker }).run('x');

const before = await run((ws) => ws.classification !== null);               // 0.1's "done once classified"
console.log(before.status, before.trace.length, calls.length, before.workingSet.gathered);
const after = await run((ws) => Object.hasOwn(ws, 'classification'));
console.log(after.status, after.trace.length, calls.length);
```

```text output
completed 0 0 undefined
completed 1 1
```

The first run "completes" without an iteration, and the classifier is never asked. Test whether a key is there
(`Object.hasOwn(ws, key)`, or `ws[key] !== undefined`) rather than whether it is `null`, and drop reads of
`ws.gathered`. In TypeScript, `WorkingSet` no longer has `gathered`: it reads as `unknown`, so using it as a list
(`ws.gathered.includes(…)`) stops compiling.

### The trace

The default trace entry holds what the run decided, so two runs of the same case give the same trace. `durationMs`
moved out of it, to the tracer's second argument; a tracer that wants it puts it back:

```js run
import { Agent, always } from '@belaykit/core';

const agent = (options) => new Agent({
  initializer: () => ({ done: false }),
  choiceProvider: async () => ({ name: 'finish', mode: 'first', choices: [{ name: 'done', criteria: always, actions: [async (ws) => { ws.done = true; }] }] }),
  finishChecker: (ws) => ws.done,
}, options);

console.log('durationMs' in (await agent().run()).trace[0]);
console.log(typeof (await agent({ tracer: (entry, { durationMs }) => ({ ...entry, durationMs }) }).run()).trace[0].durationMs);
```

```text output
false
number
```

In TypeScript, `TraceEntry` no longer has `durationMs`; a tracer's second argument is a `TraceContext`.

### The function reference

`describeFunctions` and `belaykit-rulebook reference` now list BelayKit's helpers (`belaykit.present`) before the
registry's functions, so a reference you committed beside your rulebooks differs: generate it again.

### New in 0.2

Nothing here needs a change to keep working, but each may replace code you wrote around 0.1:
[`belaykit.present`](rulebooks.md#belaykits-helpers) for a value that may be missing or `null`,
[templated params](rulebooks.md#templated-params) for wording with case values,
[`rules.decide`](rulebooks.md#deciding-with-a-rulebook) for a rulebook used as a decision function,
[guarded actions](rulebooks.md#guarded-actions), and a `version` export in each package. The full list is in
[CHANGELOG.md](../CHANGELOG.md).
