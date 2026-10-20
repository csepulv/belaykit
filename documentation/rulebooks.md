---
title: Rulebooks
---

# Rulebooks

A **rulebook** writes an agent's decisions as text: a YAML file of **sections** and **rules**, with conditions in
[CEL](https://cel.dev) (the Common Expression Language: small, side-effect-free expressions). It's checked when it
loads against your agent's **registry**, the code it may name, and a loaded `Rulebook` gives you a choice provider for
`@belaykit/core`. This page is the reference for the format and the package; [Getting started](getting-started.md)
shows one in use.

```bash
npm install @belaykit/core @belaykit/rulebook
```

## A rulebook

```yaml
# triage.rules.yaml
version: 1
sections:
  - name: gather
    when: '!("classification" in ws.gathered)'
    needs: { classification: classify_item }        # a producer fills ws.classification
  - name: decide
    when: ws.routing == null
    hitPolicy: FIRST                                 # FIRST: the first rule that holds; ALL: every rule that holds
    rules:
      - id: urgent
        when: ws.classification.urgent == true
        then: { action: settle, routing: escalate }  # `routing` is a param for the action
        why: urgent items go to a person
      - id: fallback
        when: "true"
        then: { action: settle, routing: hold }
```

| Key | Where | Meaning |
| --- | --- | --- |
| `version` | top | Always `1`. |
| `hitPolicyDefault` | top | `FIRST` or `ALL`, for sections that don't set `hitPolicy`. Default `FIRST`. |
| `sections` | top | The sections, in order. |
| `name` | section | Names the iteration in the trace. |
| `when` | section | CEL: when this section applies. |
| `needs` | section | `{ key: producer }`: working-set keys this section gathers before its rules run. |
| `hitPolicy` | section | `FIRST` (the first rule that holds) or `ALL` (every rule that holds). |
| `rules` | section | The rules. A section may have none and only gather. |
| `id` | rule | Optional. Names the rule in the trace and errors; default `<section>#<n>`, counting from 1. |
| `selectFirst` | rule | Optional. `{ name: <CEL list> }`: act on one item of a list. See [below](#selectfirst). |
| `when` | rule | CEL: when this rule holds. |
| `then` | rule | `{ action: <registered action>, ...params }`: the action to run, and literal params for it. |
| `why` | rule | Optional. Carried into the trace beside the rule's name. |

Section names, rule ids and `selectFirst` binding names match `^[a-z][a-z0-9_]*$`: a lowercase letter, then lowercase
letters, digits and underscores. So a rule is `type_next`, not `type-next` as a choice in code might be.

## How a rulebook decides

On each iteration the rulebook's provider looks at the working set (`ws` in CEL):

1. It takes the **first section whose `when` holds**. Later sections aren't tried in that iteration, even if the
   first one has nothing to do.
2. If that section has `needs` keys not yet **gathered**, it returns a choice set that runs their producers
   (`gather <key>` in the trace).
3. Otherwise it returns the section's rules as a choice set, under its hit policy: each rule is a choice named by its
   `id`, whose criteria evaluate its `when`, and whose action is the registered action in `then`.
4. If no section's `when` holds, or the claiming section only gathers and its needs are met, it returns `null`:
   nothing to offer. As an agent's only provider, that ends the run `failed`; in a `chain`, the next provider takes
   the iteration.

So a gather-only section's `when` should turn false once its work is done, or it keeps claiming the working set.

## The working set: `needs` and `gathered`

`rules.initialize(initial)` builds the working set: your initial keys, every key any section `needs` set to `null`,
and `gathered: []`. When a section gathers a key, its producer's return value becomes that key's value and the key is
added to `ws.gathered`. A producer may return `null` ("looked, found nothing"); the key still counts as gathered.

Everything else in the working set is yours to initialize and declare: initial keys in the registry's `initialKeys`,
keys an action writes in its `writes`. BelayKit assumes no particular field: your finish checker decides when the run
is done.

A key is gathered once. To have it produced again (a code check that rejects a model's answer, say), an action calls
`rules.regather(ws, key)`: the key goes back to `null` and out of `gathered`, so its section gathers it again. A key
the rulebook doesn't declare throws a `TypeError`, which ends the run `failed`, naming the key.

## Conditions in CEL

Every `when` is a CEL expression over `ws`, and it must be a boolean. One whose type is known when the rulebook loads
(a string, a number, a list) is refused then; one whose type is only known at run time (a bare `ws.flag`) fails the run
if it evaluates to anything but `true` or `false`. It's never read as "no match".

`x.y` on a map without key `y` is an error, not `null`: guard with `has(x.y)` when a field may be missing.

**Keys and fields are checked when the rulebook loads.** `ws.x` (or `ws["x"]`) must be a known key: one in
`initialKeys`, a section's `needs`, or a producer's or action's `writes`. The fields below a key are checked against
the key's **shape** in the registry, at any depth ([below](#shapes)). A field read where no shape says what it is
(a key without a shape, an object the shape leaves open) is checked only when the rule runs: a missing one fails the
run, never a silent `no_match`.

**Functions.** A rulebook may call CEL's built-in functions and macros, as
[cel-js](https://github.com/marcbachmann/cel-js#language-features) implements them: among others `size`, `has`,
`exists`, `all`, `exists_one`, `map`, `filter`, `in`, and the string methods `contains`, `startsWith`, `endsWith`,
`matches`, `lowerAscii`, `upperAscii`, `trim` and `split`. Not every CEL extension is there (`replace` isn't). A
function or method nothing defines is refused when the rulebook loads (`unknown function "app_isBlnk"`, in the
example [below](#loading-and-checking)); a known function given the wrong arguments keeps cel-js's own message, which
names the function and the argument types it was given.

It may also call any **registered function**: a pure JavaScript function the registry declares with a signature, such
as `{ signature: 'app_isBlank(string): bool', handler }`. A signature's types are CEL's: `string`, `bool`, `int`,
`uint`, `double`, `bytes`, `null_type`, `dyn`, and `list<T>` or `map<K, V>` (`list` and `map` alone mean any element
type). An `int` argument reaches the handler as a JavaScript `BigInt` (`2n`), so a handler that does arithmetic with
numbers must convert it (`Number(n)`) or use BigInts throughout. Names match `^[a-z][a-zA-Z0-9_]*$`; by convention,
prefix your own (`app_isBlank`) to keep them apart from CEL's and from functions BelayKit may add. A dotted name is
refused. A function that takes a container and a key name can declare which argument is which,
`keyArgs: { key: 1, in: 0 }`, and then a literal key passed to it is checked like a field reference.

**Patterns.** `s.matches(pattern)` runs JavaScript's backtracking regular expressions, often on model output. So a
pattern must be a string literal, must compile, and must pass
[`safe-regex2`](https://www.npmjs.com/package/safe-regex2)'s check for exponential backtracking. That check is a
heuristic: it passes `^(a|aa)+$`, which backtracks exponentially, so keep patterns simple and anchored.

## Shapes

A registry's `shapes` give a working-set key a **shape**: a JSON Schema (draft 2020-12) for its value. If your agent
already describes its data with zod, `z.toJSONSchema(schema)` is the shape, unchanged. The loader follows every field
a rulebook reads through the shapes, at any depth: from `ws.<key>`, from a `selectFirst` binding over `ws.<key>` (an
item of the list), and from a macro's variable (`exists`, `all`, `exists_one`, `map`, `filter`). A field no shape
allows is a load error:

```js run
import { Rulebook } from '@belaykit/rulebook';

const snippet = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    classification: {
      anyOf: [   // what zod writes for .nullable()
        { type: 'object', properties: { topics: { type: 'array', items: { type: 'string' } }, ambiguity: { type: 'string' } }, additionalProperties: false },
        { type: 'null' },
      ],
    },
    reviewed: { type: 'boolean' },
  },
  additionalProperties: false,
};
const registry = {
  producers: {},
  actions: { review: { writes: ['snippets'], run: async () => {} } },
  initialKeys: ['snippets'],
  shapes: { snippets: { type: 'array', items: snippet } },
};

console.log(Rulebook.check(`
version: 1
sections:
  - name: review
    when: ws.snippets.exists(s, !s.reviewd)
    rules:
      - id: flag
        selectFirst: { snippet: ws.snippets }
        when: snippet.classification != null && snippet.classification.ambigity != ""
        then: { action: review }
`, registry).join('\n'));
```

```text output
section "review" rule 1 (flag) when: unknown field "ambigity" on snippet.classification
section "review" when: unknown field "reviewd" on s (an item of ws.snippets)
```

Checking stops where a shape stops saying: at an object whose `additionalProperties` isn't `false` (zod's
`.passthrough()` writes `{}`; `unevaluatedProperties` doesn't close an object for this check), at a key without a
shape, and at a `$ref` that isn't local (`#/$defs/…` is followed). A tuple's `prefixItems` describe their own indexes
(`ws.trail[0]`) and `items` the rest.
Reading a field of a list itself, rather than of its items, is a load error. A shape for a key nothing declares is a
registry problem. Shapes are only for these checks: BelayKit doesn't validate working-set values against them.

## `selectFirst`

A rule can act on one item of a list:

```yaml
- id: probe_unknown
  selectFirst: { node: ws.nodes }
  when: node.status == "open" && node.fact == "unknown"
  then: { action: probe }
```

The rule's `when` is tried for each item in list order with the item bound to `node`; the first item for which it
holds is selected, and if none does, the rule doesn't match. The action receives `selected: { name, item, index }`,
and the trace entry records `detail: { node: <index> }`. The binding exists only in that rule's `when`, and its fields
are checked against the list's shape when it has one. A binding named
`ws`, a CEL reserved word, a name CEL already defines (`string`, `int`, `list`…) or a registered function's name is
refused when the rulebook loads.

**Each rule selects on its own.** In an `ALL` section, several rules with `selectFirst` over the same list each pick
their own first match, so in one iteration they may act on different items. When several rules must act on *the same*
item, say which item in each `when`. The example agent registers a function, `doc_waiting(snippet, snippets)`, that
holds only for the one snippet waiting for review, and every review rule calls it:

```yaml fragment examples/doc-processor/rules/doc-processor.rules.yaml
      - id: flag_ambiguity
        selectFirst: { snippet: ws.snippets }
        when: doc_waiting(snippet, ws.snippets) && snippet.classification.ambiguity != ""
        then: { action: flag_ambiguity }
        why: the classifier couldn't choose a topic
```

## The registry

The registry is what a rulebook may name, as a plain object your agent supplies:

```js fragment
const registry = {
  producers: { classify_item: { writes: ['classification'], run: async (ws, deps) => deps.classify(ws.item) } },
  actions: {
    settle: {
      writes: ['routing'],
      params: { type: 'object', properties: { routing: { enum: ['escalate', 'hold'] } }, required: ['routing'], additionalProperties: false },
      run: async (ws, { params, deps, selected }) => { ws.routing = params.routing; },
    },
  },
  functions: [{ signature: 'app_isBlank(string): bool', handler: (text) => !text.trim(), description: 'True for an empty or blank string.' }],
  initialKeys: ['item', 'routing'],                       // keys your initial working set has
  shapes: { classification: z.toJSONSchema(classification) },   // a JSON Schema per key, for the field checks
  version: '1',                                            // printed in the function reference
};
```

- A **producer** `run(ws, deps)` returns the value of its `needs` key. `writes` names the keys it sets.
- An **action** `run(ws, { params, deps, selected })` writes the working set: `params` are the rule's literal `then:`
  fields besides `action` (read-only: they're frozen when the rulebook loads), `deps` are what you passed to
  `rules.provider(deps)`, and `selected` is there for a `selectFirst` rule.
- An action's **`params`** is a JSON Schema for the params it takes, and each rule's params are checked against it
  when the rulebook loads: a missing required param, a value the schema refuses, or a param the schema doesn't name
  is a load error naming the rule. A params schema is closed by default: unless it says what to do with extra keys
  itself (`additionalProperties` or `unevaluatedProperties`), a misspelled param is refused. An action without
  `params` takes none, so a rule that passes any is a load error too.
- These are the registry's only keys; any other (an old `fields`, say) is a load problem rather than ignored.
- A rulebook keeps a copy of the registry's producers and actions when it loads, so changing your registry object
  later doesn't change what it runs.

## Loading and checking

`Rulebook.load(path, registry)` and `Rulebook.fromText(text, registry)` check everything above and throw listing every
problem, not just the first, each naming its section and rule (rules count from 1). `Rulebook.check(text, registry)`
returns the same problems as a list (`[]` when the text is clean) and never throws for a problem in the text:

```js run
import { Rulebook } from '@belaykit/rulebook';

const settle = {
  writes: ['routing'],
  params: { type: 'object', properties: { routing: { enum: ['escalate', 'hold'] } }, required: ['routing'], additionalProperties: false },
  run: async () => {},
};
const registry = { producers: {}, actions: { settle }, initialKeys: ['routing'] };

console.log(Rulebook.check(`
version: 1
sections:
  - name: decide
    when: ws.routing == null
    rules:
      - id: urgent
        when: ws.urgnet == true
        then: { action: settle, routing: urgent }
      - id: hold
        when: app_isBlnk(ws.routing)
        then: { action: settle, routng: hold }
      - when: "true"
        then: { action: setle }
`, registry).join('\n'));
```

```text output
section "decide" rule 1 (urgent): param "routing" must be one of escalate, hold
section "decide" rule 1 (urgent) when: unknown ws field "urgnet"
section "decide" rule 2 (hold): "settle" needs param "routing"
section "decide" rule 2 (hold): param "routng" isn't one "settle" takes
section "decide" rule 2 (hold) when: unknown function "app_isBlnk"
section "decide" rule 3: unknown action "setle"
```

The file's shape (its keys and their types) is checked first; while it's wrong, its problems are listed alone. So
are the registry's own problems, beside the file's:

```js run
import { Rulebook } from '@belaykit/rulebook';

const registry = { producers: {}, actions: { settle: { writes: ['routing'], run: async () => {} } }, initialKeys: ['routing'] };
const text = (hitPolicy, ruleKey) => `
version: 1
sections:
  - name: decide
    when: ws.routing == null
    hitPolicy: ${hitPolicy}
    rules:
      - ${ruleKey}: { s: ws.routing }
        when: "true"
        then: { action: settle }
`;

console.log(Rulebook.check(text('FRIST', 'selectFrist'), registry).join('\n'));
console.log(Rulebook.check(text('FIRST', 'selectFirst'), { ...registry, fields: { routing: ['x'] } }).join('\n'));
```

```text output
section "decide" hitPolicy: must be one of FIRST, ALL
section "decide" rule 1: unknown key "selectFrist"
registry: unknown key "fields" (keys: producers, actions, functions, version, initialKeys, shapes)
```

The `belaykit-rulebook` command runs the same check on files before you deploy them, and prints the registry's
functions as Markdown for a reference you commit beside your rulebooks. Installed in a project, it runs with `npx`
or from a `package.json` script:

```bash
npx belaykit-rulebook check rulebooks/*.rules.yaml --registry src/registry.js#registry   # exit 0 when every file is clean
npx belaykit-rulebook reference --registry src/registry.js#registry > rulebook-functions.md
```

`--registry` names the module (resolved from the current directory) and the export that holds the registry. Name
rulebook files `<name>.rules.yaml` if you like; the loader accepts any path.

## Running a rulebook

```js fragment
import { Agent, chain } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const rules = Rulebook.load('triage.rules.yaml', registry);
const agent = new Agent({
  initializer: (subject) => rules.initialize({ item: subject, routing: null }),
  choiceProvider: chain([rules.provider(deps), codeProvider]),   // or rules.provider(deps) alone
  finishChecker: (ws) => ws.routing !== null,
  finalizer: (ws) => ({ routing: ws.routing }),
});
```

`Rulebook.load` reads the path from the current directory, not from your module's. To load a file beside your module,
pass `fileURLToPath(new URL('triage.rules.yaml', import.meta.url))` (from `node:url`). The same goes for
`loadFixture`.

`rules.provider(deps)` is an ordinary choice provider: each rule becomes a choice named by its `id` and carrying its
`why`, and `deps` reach every producer and action. The deps are fixed when you make the agent, as `maxIterations`
is; an agent that needs different deps per subject puts them in the working set or makes an agent per subject. `rules.sections` and `rules.declaredKeys` show what was loaded (as
copies). Only `Rulebook.load` and `Rulebook.fromText` make a rulebook, so every one has passed its checks.

## Fixtures

A **fixture** pins what a rulebook decides, as text: where a run starts, what each producer returns, and how the run
should end. No model is called; the registry's real actions run with the `deps` you give.

```yaml
initial: { item: "server down", routing: null }
produce: { classification: { urgent: true } }
expect: { status: completed, fired: ["gather classification", "urgent"], result: { routing: escalate } }
```

`rules.runFixture({ fixture: loadFixture(path), deps, finishChecker, finalizer })` runs it and returns
`{ status, result, error, trace, workingSet, mismatches }`, with `mismatches` empty when `expect` holds: `fired` is
compared with every iteration's `fired` in order, `result` by deep equality (so if your code puts a `BigInt` from a
function in the result, YAML's `2` won't equal it), and `error` must be part of a failed run's message. A `needs` key the run asks for and `produce` lacks
fails the run and is named as a mismatch.

A fixture runs the rulebook **alone**, not chained with code: a code provider your agent chains after the rulebook,
and what it does (such as `regather`), isn't part of a fixture run. Start the fixture's `initial` working set where
the rulebook's own decisions begin. The example agent's fixture starts after its code check, with three classified
snippets, and states the flags the review must raise.

```js run
import { loadFixture, Rulebook } from '@belaykit/rulebook';
import { writeFileSync } from 'node:fs';

const registry = {
  producers: { classify_item: { writes: ['classification'], run: async () => { throw new Error('not in a fixture'); } } },
  actions: { settle: { writes: ['routing'], params: { type: 'object', properties: { routing: { enum: ['escalate', 'hold'] } }, required: ['routing'], additionalProperties: false }, run: async (ws, { params }) => { ws.routing = params.routing; } } },
  initialKeys: ['item', 'routing'],
};
const rules = Rulebook.fromText(`
version: 1
sections:
  - name: gather
    when: '!("classification" in ws.gathered)'
    needs: { classification: classify_item }
  - name: decide
    when: ws.routing == null
    rules:
      - id: urgent
        when: ws.classification.urgent == true
        then: { action: settle, routing: escalate }
      - id: fallback
        when: "true"
        then: { action: settle, routing: hold }
`, registry);

writeFileSync('triage-fixture.yaml', 'initial: { item: "server down", routing: null }\nproduce: { classification: { urgent: true } }\nexpect: { status: completed, fired: ["gather classification", "urgent"], result: { routing: escalate } }\n');
const run = await rules.runFixture({ fixture: loadFixture('triage-fixture.yaml'), finishChecker: (ws) => ws.routing !== null, finalizer: (ws) => ({ routing: ws.routing }) });
console.log(run.status, run.mismatches);
```

```text output
completed []
```

## Errors at run time

A run that a rulebook drives fails, naming its place, when a section's `when` or a rule's `when` isn't a boolean (or
fails), when a `selectFirst` expression isn't a list, when a `selectFirst` rule's `when` fails for one item (counted
from 0, like `selected.index`), when an action throws (or calls `regather` with an undeclared key), and when a
producer throws. In that order:

```js run
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const registry = {
  producers: { classify_item: { writes: ['classification'], run: async () => { throw new Error('model unavailable'); } } },
  actions: {
    settle: { writes: ['routing'], run: async () => { throw new Error('store unavailable'); } },
    probe: { writes: ['routing'], run: async () => {} },
  },
  initialKeys: ['routing', 'flag', 'nodes'],
};

async function failureOf(sections) {
  const rules = Rulebook.fromText(`version: 1\nsections:\n${sections}`, registry);
  const agent = new Agent({
    initializer: () => rules.initialize({ routing: null, flag: 'yes', nodes: [{ status: 'open' }] }),
    choiceProvider: rules.provider(),
    finishChecker: (ws) => ws.routing !== null,
  });
  return (await agent.run()).error.message;
}

const decide = (rule, when = 'ws.routing == null') => `  - name: decide\n    when: ${JSON.stringify(when)}\n    rules:\n${rule}`;
console.log(await failureOf(decide('      - when: "true"\n        then: { action: probe }\n', 'ws.flag')));
console.log(await failureOf(decide('      - id: urgent\n        when: ws.flag\n        then: { action: probe }\n')));
console.log(await failureOf(decide('      - id: probe_unknown\n        selectFirst: { node: ws.flag }\n        when: node == "x"\n        then: { action: probe }\n')));
console.log(await failureOf(decide('      - id: probe_unknown\n        selectFirst: { node: ws.nodes }\n        when: node.statsu == "open"\n        then: { action: probe }\n')));
console.log(await failureOf(decide('      - id: urgent\n        when: "true"\n        then: { action: settle }\n')));
console.log(await failureOf(`  - name: gather\n    when: '!("classification" in ws.gathered)'\n    needs: { classification: classify_item }\n`));
```

```text output
iteration 1 choiceProvider failed: section "decide" when failed: when evaluated to string, expected a boolean
decide/urgent criteria failed: when evaluated to string, expected a boolean
decide/probe_unknown criteria failed: selectFirst evaluated to string, expected a list
decide/probe_unknown criteria failed: node = item 0: No such key: statsu
decide/urgent action failed: store unavailable
gather/gather classification action failed: model unavailable
```

(The fourth would be a load error if the registry gave `nodes` a shape.)

Like every BelayKit run, it still resolves, with the error and the trace so far.
