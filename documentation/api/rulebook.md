---
title: "@belaykit/rulebook API"
---

# `@belaykit/rulebook` API

Every export of `@belaykit/rulebook`. [Rulebooks](../rulebooks.md) explains the file format and how a rulebook
decides; this page is the reference for the code. The package depends on `ajv`, `yaml`, `@marcbachmann/cel-js` and
`safe-regex2`, and takes `@belaykit/core` as a peer dependency.

```js fragment
import { describeFunctions, loadFixture, Rulebook, schemaVersions, version } from '@belaykit/rulebook';
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
literal keys passed to a function with `keyArgs`), fields the registry's `shapes` don't allow, string literals
compared with a field whose shape lists other values (`enum`, `const`), `needs` keys named like
an `Object.prototype` property, `matches` patterns that aren't literals, don't compile, or may backtrack
exponentially, a macro variable named `belaykit`, a `belaykit.present` path that isn't a string literal, has an empty
key, or reads a field the known keys and shapes don't allow (checked as field access is), templated params (a
placeholder checked like a `when`, a known type that can't become text, a stray or empty brace) and a brace in a param
the action doesn't template, and `selectFirst` bindings: a name that is `ws`, `belaykit`, a CEL reserved word or a
registered function's, a list expression whose type is known and isn't a list, and a binding used outside its rule;
a `FIRST` section with rules that neither ends in a rule with `when: "true"` (without `selectFirst`, on an action
without a `guard`) nor says `exhaustive: false`, and `exhaustive` where it means nothing; `outputs` that no action
writes or that gathering would set (a `needs` key, a producer's `writes`); the `guard` of each action a rule names,
checked like a `when` and reported once per action.
The registry's own problems are listed too: an unknown key (in the registry, on a producer or on an action), a
function that won't register, a `params` or shape schema that won't compile, `templates` that don't name plain-string
params, a `guard` that isn't a string, a shape for a key nothing declares.

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

A copy of the agent's initial working set, with nothing added: a `needs` key is absent until its section gathers it
(it is gathered when present, and not holding `undefined`). Throws a `TypeError` naming the key when `initial` already holds a declared `needs`
key, `null` included, since it would count as gathered and its producer would never run.

#### `rulebook.provider(deps)`

```ts
provider(deps?: unknown): ChoiceProvider<WorkingSet>;
```

The choice provider, with the deps its producers and actions receive. They're fixed when you pass the provider to
`new Agent`, so every run of that agent gets the same deps. Returns `null` when no section claims the
working set, so it composes with code providers through `chain`. Each rule becomes a choice named by its `id`,
carrying its `why`. A `selectFirst` rule matches on the first item, in list order, for which its `when` holds; its
action receives `selected`, and its trace entry `detail: { <name>: <index> }`. A rule whose action has a `guard` is
checked against it first: a false guard doesn't match (`detail: { guard: false }`), and the rule's `when` and
selection aren't evaluated. A `when` or guard that evaluates to anything but a boolean, or a `selectFirst` expression
that evaluates to anything but a list, ends the run `failed`, naming the section (and rule).

#### `rulebook.regather(workingSet, key)`

```ts
regather(workingSet: WorkingSet, key: string): void;
```

Has a `needs` key gathered again: removes it from the working set, so its section gathers it again. Called from an
action (actions are the working set's only writers). Throws a `TypeError` for a key this
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

#### `rulebook.decide(initial, options)`

```ts
decide(initial?: Record<string, unknown>, options?: { deps?: unknown; maxIterations?: number }): Promise<Decision>;
```

The rulebook as a decision function ([Deciding with a rulebook](../rulebooks.md#deciding-with-a-rulebook)): a run on
the core's `Agent`, from `initialize(initial)`, until every key in the rulebook's `outputs` is present. Always resolves;
an output or `needs` key already present in `initial` fails the run, naming it. `deps` reach producers and actions;
`maxIterations` bounds the run (default 25). The trace is the default one. Rejects with a `TypeError` when the
rulebook declares no `outputs`, for an option it doesn't take, or for an option's bad value (`maxIterations: 0`).

### `Decision`

```ts
type Decision =
  | { status: 'completed'; outputs: Record<string, unknown>; trace: TraceEntry[] }
  | { status: 'no_match' | 'failed'; error: string; trace: TraceEntry[] };
```

What `decide` resolves to. `completed`: every output is present, with its value in `outputs`. `no_match`: nothing
applied (no section claimed the working set, or one claimed and no rule held); `error` names the unset outputs and the
sections as the provider asked them (those before the claiming one, that one, and the rest as not reached). `failed`:
something broke; `error` is the run's own message.

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
type WorkingSet = Record<string, unknown>;
```

A working set as a rulebook sees it: `ws` in CEL. Every key is the agent's; a `needs` key is gathered when it is
present. (Before 0.2 the plugin kept a list, `gathered`; a rulebook that reads `ws.gathered` now fails to load, saying
to test `has(ws.<key>)`.)

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
problem. Function names match `^[a-z][a-zA-Z0-9_]*$`, conventionally `<prefix>_<name>`; a dotted name is refused,
and so are the name `belaykit`, a method on its type, `BelayKit`, and a method on `dyn` that would overlap a helper
(its name and arguments), which belong to (or would also apply to) BelayKit's own helpers
([Rulebooks](../rulebooks.md#belaykits-helpers)).

`shapes` describe ws keys for the loader: every field a rulebook reads is followed through them, at any depth, from
`ws.<key>`, from a `selectFirst` binding over `ws.<key>` (an item of the list) and from a macro's variable (`exists`,
`all`, `exists_one`, `map`, `filter`). A field no shape allows is a load error, and so is a string literal compared
(`==`, `!=`, `in [...]`) with a field whose shape lists its values (`enum`, `const`) but not that one. Checking stops at an object whose
`additionalProperties` isn't `false` (`unevaluatedProperties` doesn't close one for the check), at a key without a
shape, and at a non-local `$ref`; a tuple's `prefixItems` describe their own indexes. A shape must be for a key
the registry or the rulebook declares (`initialKeys`, `writes`, `needs`). Working-set values aren't validated against
shapes.

### `Producer`

```ts
interface Producer<Deps = unknown> { writes?: string[]; run(ws: WorkingSet, deps: Deps): Promise<unknown> }
```

Fills one `needs` key: returns its value. `null` is a valid answer ("looked, found nothing") and counts as gathered;
`undefined` fails the run, naming the producer and the key, since the key would read as absent. `writes` names the
keys it sets, for the loader's key check. Any other key on a producer is a load problem, for one made from a class
too: dependencies come through `deps`.

### `RegisteredAction`

```ts
interface RegisteredAction<Deps = unknown> {
  writes?: string[];
  params?: JsonSchema;   // the rule's `then:` fields besides `action`, checked at load
  templates?: string[];  // the params a rule may fill from the case
  guard?: string;        // CEL on ws that must hold for any rule to run it
  run(ws: WorkingSet, context: ActionContext<Deps>): Promise<void>;
}
```

An action a rule may name, with the keys it writes and the params it takes. A rule's params are checked against
`params` when the rulebook loads: a missing required param, a value the schema refuses or a param the schema doesn't
name is a load error naming the rule and the param. The schema is closed by default: one that doesn't set
`additionalProperties` or `unevaluatedProperties` itself is read with `unevaluatedProperties: false`, which also counts
the params `allOf`, `$ref` or `if`/`then` allow. An action without `params` takes none, so a rule that passes any is a
load error too.

`templates` names the params whose text a rule may fill from the case, with placeholders, CEL inside braces
(`"{ws.customer.name} wrote"`; [Templated params](../rulebooks.md#templated-params)). Each must be a top-level param of
`params` whose schema is a plain string: `type: "string"` with annotations only (`description`, `title`, `examples`,
`default`, `deprecated`, `readOnly`, `writeOnly`, `$comment`). Placeholders are checked at load like a rule's `when`,
and filled just before the action runs; a value that isn't a string, number or boolean fails the run. A brace in a
param the action doesn't template is a load error.

`guard` is a CEL expression on `ws` that must hold for any rule to run the action
([Guarded actions](../rulebooks.md#guarded-actions)). It's evaluated before the rule's `when` and selection, which
aren't evaluated when it's false: the rule doesn't match, with `detail: { guard: false }` in the trace. It's checked
again just before the action runs (in an `ALL` section an earlier action may have changed `ws`), and one that no
longer holds fails the run. It's checked at load like a `when`, once per action, for the actions a rulebook names; one
that throws or isn't a boolean at run time fails the run. A last `when: "true"` rule on a guarded action isn't a section's catch-all.

Any key on an action besides these five is a load problem, for one made from a class too: dependencies come through
`deps`.

### `JsonSchema`

```ts
type JsonSchema = boolean | Record<string, unknown>;
```

A JSON Schema, draft 2020-12: what zod 4's `z.toJSONSchema` writes, so an agent that already describes its data with
zod can pass that description as is. A schema without `$schema` is read as 2020-12.

### `ActionContext`

```ts
interface ActionContext<Deps = unknown> {
  params: Readonly<Record<string, unknown>>;   // the rule's `then:` fields besides `action`, templates filled; frozen
  deps: Deps;
  selected?: SelectedItem;                     // present when the rule has `selectFirst`
}
```

What a registered action receives beside the working set. `params` have passed the action's `params` schema at load;
a templated param holds the filled text, the rule's own params keep the template.

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

What a rulebook may call, as Markdown: BelayKit's helpers (`belaykit.*`) first, then the registry's functions, each
with its signature, description and parameters, a note for `keyArgs`, and `version` in the header when set. CEL's
built-in functions are left out. Throws when a function fails to register.
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
when it's malformed: YAML that doesn't parse, or a fixture of the wrong shape.

## Versions

### `version`

```ts
const version: string;
```

The package's version, as in its `package.json`. It names the release, not the installed files: a locally edited copy
reports the same version.

### `schemaVersions`

```ts
const schemaVersions: readonly number[];
```

The rulebook `version:` values this package reads, today `[1]`. A rulebook with any other version is a load error.

## The command

`belaykit-rulebook` (installed with the package; run it with `npx` or from a `package.json` script) runs
`Rulebook.check` on files, or prints `describeFunctions`:

```bash
npx belaykit-rulebook check <file>... --registry <module>#<export>   # exit 0 when every file is clean, 1 otherwise
npx belaykit-rulebook reference --registry <module>#<export>
```

`--registry` names the module, resolved from the current directory, and the export holding the registry. Each problem
is printed prefixed by its file; a fatal error (a bad registry) is prefixed `belaykit-rulebook:`.
