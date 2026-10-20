---
title: "@belaykit/rulebook API"
---

# `@belaykit/rulebook` API

Every export of `@belaykit/rulebook`. [Rulebooks](../rulebooks.md) explains the file format and how a rulebook
decides; this page is the reference for the code. The package depends on `ajv`, `yaml`, `@marcbachmann/cel-js` and
`safe-regex2`, and takes `@belaykit/core` as a peer dependency.

```js fragment
import { describeFunctions, loadFixture, Rulebook } from '@belaykit/rulebook';
```

## The rulebook

### `Rulebook`

A rulebook loaded and checked against a registry, which it keeps (a copy of its producers and actions). Only
`Rulebook.load` and `Rulebook.fromText` make one; `new Rulebook()` throws.

#### `Rulebook.load(path, registry)`

```ts
static load(path: string, registry: Registry<any>): Rulebook;
```

Loads and checks a rulebook file: the file's shape, then function names, unregistered producers and actions, each
rule's params against its action's `params`, CEL that fails to compile or calls an unknown function, predicates whose
type is known and isn't `bool`, rules sharing an explicit `id`, `ws` keys nothing declares (`ws.x`, `ws["x"]`, and
literal keys passed to a function with `keyArgs`), fields the registry's `shapes` don't allow, `needs` keys named like
an `Object.prototype` property, `matches` patterns that aren't literals, don't compile, or may backtrack
exponentially, and `selectFirst` bindings: a name that is `ws`, a CEL reserved word or a registered function's, a
list expression whose type is known and isn't a list, and a binding used outside its rule. The registry's own
problems are listed too: an unknown key, a function that won't register, a `params` or shape schema that won't
compile, a shape for a key nothing declares.

Throws listing every problem, each naming its section and rule (rules count from 1): the file's shape problems alone
if there are any, then everything else. A relative `path` is resolved from the current directory (`process.cwd()`),
not from the calling module. A `path` that isn't a string is a `TypeError`.

#### `Rulebook.fromText(text, registry)`

```ts
static fromText(text: string, registry: Registry<any>): Rulebook;
```

The same, from text; `text` that isn't a string is a `TypeError`.

#### `Rulebook.check(text, registry)`

```ts
static check(text: string, registry: Registry<any>): string[];
```

Every problem `fromText` would throw for, one string each; `[]` when the text is clean. YAML that doesn't parse is one
problem (`YAML: …`). Never throws for a problem in the text; a broken registry (one without `producers` or `actions`)
still throws, and so does `text` that isn't a string (a `TypeError`).

#### `rulebook.sections`, `rulebook.declaredKeys`

```ts
readonly sections: Section[];
readonly declaredKeys: string[];
```

The sections as loaded, and every `needs` key across them. Both are copies: changing them doesn't change the
rulebook.

#### `rulebook.initialize(initial)`

```ts
initialize<Initial extends Record<string, unknown>>(initial: Initial): Initial & WorkingSet;
```

The agent's initial keys, plus every declared `needs` key as `null`, and `gathered: []`.

#### `rulebook.provider(deps)`

```ts
provider(deps?: unknown): ChoiceProvider<WorkingSet>;
```

The choice provider, with the deps its producers and actions receive. They're fixed when you pass the provider to
`new Agent`, so every run of that agent gets the same deps. Returns `null` when no section claims the
working set, so it composes with code providers through `chain`. Each rule becomes a choice named by its `id`,
carrying its `why`. A `selectFirst` rule matches on the first item, in list order, for which its `when` holds; its
action receives `selected`, and its trace entry `detail: { <name>: <index> }`. A `when` that evaluates to anything but
a boolean, or a `selectFirst` expression that evaluates to anything but a list, ends the run `failed`, naming the
section (and rule).

#### `rulebook.regather(workingSet, key)`

```ts
regather(workingSet: WorkingSet, key: string): void;
```

Has a `needs` key gathered again: sets it back to `null` and removes it from `gathered`, so its section gathers it
again. Called from an action (actions are the working set's only writers). Throws a `TypeError` for a key this
rulebook doesn't declare.

#### `rulebook.runFixture(options)`

```ts
runFixture(options: {
  fixture: Fixture;
  deps?: unknown;
  finishChecker: FinishChecker<WorkingSet>;
  finalizer?: Finalizer<WorkingSet, unknown>;
  maxIterations?: number;
}): Promise<FixtureRun>;
```

Runs the rulebook on the core's `Agent`, alone (not chained with code), with producers replaced by `fixture.produce`,
the registry's real actions given `deps`, and the finalizer if given. A `needs` key the run asks for and `produce`
lacks fails the run, and is named as a mismatch. The run uses the default trace. Rejects with a `TypeError` for an
option it doesn't take, or without `fixture` or `finishChecker`.

### `Section`

```ts
interface Section {
  name: string;
  when: string;
  needs: Record<string, string>;   // needs key → producer name
  hitPolicy: 'FIRST' | 'ALL';
  rules: Rule[];
}
```

A section as loaded: when it applies, what it gathers, how its rules are selected, and its rules.

### `Rule`

```ts
interface Rule {
  id: string;                                                  // its own id, or `<section>#<n>`
  selectFirst: { name: string; expression: string } | null;
  when: string;
  action: string;
  params: Record<string, unknown>;                             // the rule's `then:` fields besides `action`
  why: string | null;
}
```

A rule as loaded. Each becomes a choice at run time, named by its `id`; explicit ids are unique within a section.

### `WorkingSet`

```ts
type WorkingSet = Record<string, unknown> & { gathered: string[] };
```

A working set as a rulebook sees it: `ws` in CEL. `gathered` is the plugin's own (the `needs` keys produced so far);
every other key is the agent's.

## The registry

### `Registry`

```ts
interface Registry<Deps = unknown> {
  producers: Record<string, Producer<Deps>>;
  actions: Record<string, RegisteredAction<Deps>>;
  functions?: RegisteredFunction[];
  version?: string;                    // printed in the function reference's header
  initialKeys?: string[];              // ws keys the agent sets when it initializes the working set
  shapes?: Record<string, JsonSchema>; // a JSON Schema per ws key, for the field checks at load
}
```

What a rulebook may name. Each agent supplies its own, as a plain object in this shape; a key outside it is a load
problem. Function names match `^[a-z][a-zA-Z0-9_]*$`, conventionally `<prefix>_<name>`; a dotted name is refused.

`shapes` describe ws keys for the loader: every field a rulebook reads is followed through them, at any depth, from
`ws.<key>`, from a `selectFirst` binding over `ws.<key>` (an item of the list) and from a macro's variable (`exists`,
`all`, `exists_one`, `map`, `filter`). A field no shape allows is a load error. Checking stops at an object whose
`additionalProperties` isn't `false` (`unevaluatedProperties` doesn't close one for the check), at a key without a
shape, and at a non-local `$ref`; a tuple's `prefixItems` describe their own indexes. A shape must be for a key
the registry or the rulebook declares (`initialKeys`, `writes`, `needs`). Working-set values aren't validated against
shapes.

### `Producer`

```ts
interface Producer<Deps = unknown> { writes?: string[]; run(ws: WorkingSet, deps: Deps): Promise<unknown> }
```

Fills one `needs` key: returns its value. `null` is a valid answer ("looked, found nothing") and still counts as
gathered. `writes` names the keys it sets, for the loader's key check.

### `RegisteredAction`

```ts
interface RegisteredAction<Deps = unknown> {
  writes?: string[];
  params?: JsonSchema;   // the rule's `then:` fields besides `action`, checked at load
  run(ws: WorkingSet, context: ActionContext<Deps>): Promise<void>;
}
```

An action a rule may name, with the keys it writes and the params it takes. A rule's params are checked against
`params` when the rulebook loads: a missing required param, a value the schema refuses or a param the schema doesn't
name is a load error naming the rule and the param. The schema is closed by default: one that doesn't set
`additionalProperties` or `unevaluatedProperties` itself is read with `unevaluatedProperties: false`, which also counts
the params `allOf`, `$ref` or `if`/`then` allow. An action without `params` takes none, so a rule that passes any is a
load error too.

### `JsonSchema`

```ts
type JsonSchema = boolean | Record<string, unknown>;
```

A JSON Schema, draft 2020-12: what zod 4's `z.toJSONSchema` writes, so an agent that already describes its data with
zod can pass that description as is. A schema without `$schema` is read as 2020-12.

### `ActionContext`

```ts
interface ActionContext<Deps = unknown> {
  params: Readonly<Record<string, unknown>>;   // the rule's literal `then:` fields besides `action`; frozen at load
  deps: Deps;
  selected?: SelectedItem;                     // present when the rule has `selectFirst`
}
```

What a registered action receives beside the working set. `params` have passed the action's `params` schema at load.

### `SelectedItem`

```ts
interface SelectedItem { name: string; item: unknown; index: number }
```

The item a `selectFirst` rule selected: its binding name, the item, and its index in the list. The index lets an
action replace the item rather than mutate it.

### `RegisteredFunction`

```ts
interface RegisteredFunction {
  signature: string;                                   // e.g. 'app_isBlank(string): bool'
  handler: (...args: any[]) => unknown;
  description?: string;                                // shown in the function reference
  params?: { name: string; description?: string }[];   // shown in the function reference
  keyArgs?: { key: number; in: number };
}
```

A pure CEL function a rulebook may call. The signature uses CEL's type names (`string`, `bool`, `int`, `uint`,
`double`, `bytes`, `dyn`, `list<T>`, `map<K, V>`); an `int` argument reaches the handler as a `BigInt`. With `keyArgs`, argument `key` names a field of argument `in`, and a
string-literal key passed with `ws` or `ws.<key>` as its container is checked at load like a field reference. Only for
global functions; a method with `keyArgs` is refused.

### `describeFunctions`

```ts
function describeFunctions(registry: Registry<any>): string;
```

The registry's functions as Markdown: each signature, description and parameters, a note for `keyArgs`, and
`version` in the header when set. CEL's built-in functions are left out. Throws when a function fails to register.
`belaykit-rulebook reference` prints it.

## Fixtures

### `Fixture`

```ts
interface Fixture {
  initial: Record<string, unknown>;          // passed to rulebook.initialize
  produce?: Record<string, unknown>;         // the value each needs key gets; producers aren't called
  expect: { status: 'completed' | 'no_match' | 'failed'; fired?: string[]; result?: unknown; error?: string };
}
```

A rulebook run written as text: where it starts, what producers return, how it should end. `fired` is compared with
every iteration's `fired`, concatenated in order; `result` with the run's result, by deep equality; `error` must be
part of a failed run's error message.

### `FixtureRun`

```ts
interface FixtureRun {
  status: 'completed' | 'no_match' | 'failed';
  result?: unknown;
  error?: string;
  trace: TraceEntry[];
  workingSet: WorkingSet | null;
  mismatches: string[];
}
```

What `rulebook.runFixture` returns. `mismatches` is empty when `fixture.expect` holds. `result` is present unless the
run failed; `error` (the message) only when it failed.

### `loadFixture`

```ts
function loadFixture(path: string): Fixture;
```

Reads a YAML fixture, resolving a relative `path` from the current directory. Throws naming the file and each problem
when the fixture has the wrong shape; YAML that doesn't parse throws the `yaml` parser's own error.

## The command

`belaykit-rulebook` (installed with the package; run it with `npx` or from a `package.json` script) runs
`Rulebook.check` on files, or prints `describeFunctions`:

```bash
npx belaykit-rulebook check <file>... --registry <module>#<export>   # exit 0 when every file is clean, 1 otherwise
npx belaykit-rulebook reference --registry <module>#<export>
```

`--registry` names the module, resolved from the current directory, and the export holding the registry. Each problem
is printed prefixed by its file; a fatal error (a bad registry) is prefixed `belaykit-rulebook:`.
