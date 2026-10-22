---
title: "@belaykit/core API"
---

# `@belaykit/core` API

Every export of `@belaykit/core`, in the order [Concepts](../concepts.md) introduces them. Types are TypeScript
declarations (`.d.ts`) shipped with the package; the package itself is JavaScript with no dependencies.

```js fragment
import { Agent, always, chain, IterationLimitError, version } from '@belaykit/core';
// or, beside another library's Agent:
import * as belay from '@belaykit/core';   // new belay.Agent(...)
```

## The agent

### `Agent`

```ts
class Agent<Subject, State, Result = State, Entry = TraceEntry> {
  constructor(essentials: AgentEssentials<Subject, State, Result>, options?: AgentOptions<Entry>);
  run(subject: Subject): Promise<Outcome<State, Result, Entry>>;
}
```

A BelayKit agent: configured once, run per subject. The constructor throws a `TypeError` when the essentials aren't
an object; for a key either argument doesn't take, naming it and, for an option among the essentials (or the
reverse), the argument it belongs in; and for a part of the wrong kind, naming it: `initializer`, `choiceProvider`
and `finishChecker` must be functions, `finalizer` a function if given, `tracer` a function or `false`, and
`maxIterations` a positive integer. Options may be left out or `null`.

#### `agent.run(subject)`

Runs one subject and always resolves. It ends `failed` when the initializer, the provider, the finish checker, a
criterion or an action throws; when the provider returns no choice set, or a set has an unknown mode, is missing a
group, holds something that isn't a choice with a string `name` and a function `criteria`, or repeats a choice name; when a criterion returns
anything but `{ matched: boolean }`; when the finalizer or
the tracer throws; or when the iteration limit is reached. The loop stops at the first error; isolating per unit of
work is the agent's job. `run` is a method: call it as `agent.run(subject)`.

### `AgentEssentials`

```ts
interface AgentEssentials<Subject, State, Result = State> {
  initializer: Initializer<Subject, State>;
  choiceProvider: ChoiceProvider<State>;
  finishChecker: FinishChecker<State>;
  finalizer?: Finalizer<State, Result>;   // default: the working set itself
}
```

What makes the agent this agent.

### `Initializer`

```ts
type Initializer<Subject, State> = (subject: Subject) => State | Promise<State>;
```

Builds the working set for one subject. A failure here ends the run `failed` with `workingSet: null`.

### `FinishChecker`

```ts
type FinishChecker<State> = (workingSet: Readonly<State>) => boolean | Promise<boolean>;
```

Checked before each provider call; `true` ends the run `completed`. May be sync or async.

### `Finalizer`

```ts
type Finalizer<State, Result> = (workingSet: Readonly<State>) => Result | Promise<Result>;
```

The run's result, from the final working set of a `completed` or `no_match` run. A finalizer that throws ends the run
`failed`.

## Providers and choices

### `ChoiceProvider`

```ts
type ChoiceProvider<State> = (workingSet: Readonly<State>) => Promise<ChoiceSet<State> | null>;
```

Given the working set, the choices that make sense now, or `null` for nothing to offer. Called again after every
unfinished iteration; it may return a different set each time. In a `chain`, `null` hands the iteration to the next
provider; as the agent's provider, `null` ends the run `failed`.

### `ChoiceSet`

```ts
type ChoiceSet<State> =
  | { name?: string; mode: 'first' | 'all'; choices: Choice<State, any>[] }
  | { name?: string; mode: 'first_else_all' | 'first_then_all'; first: Choice<State, any>[]; all: Choice<State, any>[] };
```

The choices for one iteration and how to select among them:

- `first`: the first matching choice, in order.
- `all`: every matching choice.
- `first_else_all`: the first match in `first`; only if there is none, every match in `all`.
- `first_then_all`: the first match in `first` and every match in `all`.

Every mode selects before any action runs, so all choices in an iteration see the same working set; selected actions
then run in order (`first` before `all`). `name` labels the iteration in the trace.

### `Choice`

```ts
interface Choice<State, Data = unknown> {
  name: string;
  why?: string;
  criteria: Criteria<State, Data>;
  actions: Action<State, Data>[];
}
```

A criterion and the actions to run, in order, when it matches. `name` appears in the trace and in error messages and
must be unique within its choice set (across both groups); `why` is carried into the trace beside it.

### `Criteria`

```ts
type Criteria<State, Data = unknown> = (workingSet: Readonly<State>) => Promise<CriteriaResult<Data>>;
```

Decides whether a choice applies now. May do I/O (a lookup, a model call); by convention it doesn't change the working
set.

### `CriteriaResult`

```ts
interface CriteriaResult<Data = unknown> { matched: boolean; data?: Data; detail?: unknown }
```

What a criterion reports. `data` is handed to that choice's actions; `detail` is a small, JSON-safe note recorded in
the trace. `data` never is.

### `Action`

```ts
type Action<State, Data = unknown> = (workingSet: State, match: CriteriaResult<Data>) => Promise<void>;
```

Runs for a selected choice. Actions are the only writers of the working set.

### `always`

```ts
function always(): Promise<CriteriaResult<never>>;
```

A criterion that matches any working set, for unconditional steps and fallbacks: `{ name: 'fallback', criteria:
always, actions: [...] }`.

### `chain`

```ts
function chain<State>(providers: ChoiceProvider<State>[]): ChoiceProvider<State>;
```

Composes providers: the first that returns a choice set claims the iteration. A chain is a provider like any other:
it returns `null` when none of its providers claims the working set, so chains nest.

## Outcomes and errors

### `Outcome`

```ts
type Outcome<State, Result = State, Entry = TraceEntry> =
  | { status: 'completed' | 'no_match'; result: Result; workingSet: State; trace: Entry[] }
  | { status: 'failed'; error: RunError<Entry>; workingSet: State | null; trace: Entry[] };
```

How a run ended:

- `completed`: the finish checker returned `true`.
- `no_match`: a choice set selected nothing, so the run couldn't make progress.
- `failed`: something threw (`error` names the source by the part's name: `initializer`, `finishChecker`,
  `finalizer`, `tracer`, `iteration <n> choiceProvider`, `<set>/<choice> criteria` or `action`), the provider returned
  no choice set, or the iteration limit was reached (`error` is an `IterationLimitError`). `workingSet` is as the error
  left it, or `null` if the initializer failed. A failed run has no `result`.

`trace` holds what the tracer kept (by default, every entry).

### `RunError`

```ts
interface RunError<Entry = TraceEntry> extends Error { trace: Entry[] }
```

The error of a `failed` run: its source is named in the message, and it carries the trace.

### `IterationLimitError`

```ts
class IterationLimitError extends Error { constructor(maxIterations: number, trace: unknown[]); trace: unknown[] }
```

The error of a run that hadn't finished after `maxIterations` iterations. Its `trace` holds what the tracer kept. Reaching
the limit adds no trace entry of its own.

## The trace

### `TraceEntry`

```ts
interface TraceEntry {
  iteration: number;
  set: string;                     // the choice set's name, or `set <iteration>`
  mode?: string;                   // once the provider has returned a set
  fired: string[];                 // selected choices whose actions all completed
  evaluated: EvaluatedChoice[];    // every criterion that ran, in order, across both groups
  unevaluated: string[];           // choices whose criteria never ran
  executed: { choice: string; action: number }[];   // each action that completed, by index
  failed?: true;                   // only on the iteration that failed
}
```

One iteration as the loop saw it: the default trace entry, and what a tracer receives. It's started after the finish
check, filled in as the iteration runs, and kept as the iteration ends, so an iteration that fails leaves a partial
entry. A `no_match` iteration is recorded with `fired: []`. `unevaluated` is empty when a set's mode is unknown. It
holds only what the run decided, so two runs of the same subject give the same default trace; what was measured, such
as the iteration's duration, reaches the tracer beside it ([`TraceContext`](#tracecontext)).

### `EvaluatedChoice`

```ts
type EvaluatedChoice =
  | { choice: string; matched: boolean; why?: string; detail?: unknown }
  | { choice: string; error: string; why?: string };
```

A criterion that ran: whether it matched (with its `detail`), or the error it threw (or the bad result it returned).

### `CriterionMatch`

```ts
interface CriterionMatch { choice: string; result: CriteriaResult }
```

Each criterion of one iteration that returned a valid result, `data` included, as a tracer sees it.

## Options (incidental)

### `AgentOptions`

```ts
interface AgentOptions<Entry = TraceEntry> {
  tracer?: false | Tracer<Entry>;   // default: keep every entry as is; false keeps no trace
  maxIterations?: number;           // default 25
}
```

The incidentals. `maxIterations` (a positive integer) guards against a run that never finishes; it's fixed when the
agent is made, so set it for the largest subject you expect. A run that hasn't finished after that many iterations
ends `failed` with an `IterationLimitError`, whose message names the limit.

### `Tracer`

```ts
type Tracer<Entry> = (entry: TraceEntry, context: TraceContext) => Entry | null | undefined;
```

What to keep of an iteration, called as it ends (a failed one included): the entry, a reshaped entry, or `null` or
`undefined` to keep nothing for it. To keep timings, add them from the context:
`(entry, { durationMs }) => ({ ...entry, durationMs })`. A tracer that throws ends the run `failed`, unless the
iteration had already failed: then the run keeps its own error, and that entry is kept as the tracer received it (with any change the tracer made to it). This is
BelayKit's own trace hook, not OpenTelemetry's `tracer`.

### `TraceContext`

```ts
interface TraceContext {
  matches: CriterionMatch[];   // each criterion that returned a valid result, data included
  durationMs: number;          // how long the iteration took, in whole milliseconds
}
```

What a tracer receives beside the entry: what was measured rather than decided, kept out of the default entry so the
default trace is the same on every run of the same subject.

## Version

### `version`

```ts
const version: string;
```

The package's version, as in its `package.json` (`belaykit` exports its own, the same number). It names the release,
not the installed files: a locally edited copy reports the same version.
