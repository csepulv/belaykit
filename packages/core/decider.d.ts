/** What a criterion reports for one choice. `data` is handed to that choice's actions. */
export interface CriteriaResult<Data = unknown> {
  matched: boolean;
  data?: Data;
  /** A small, JSON-safe note recorded in this choice's trace entry. `data` never is. */
  detail?: unknown;
}

/**
 * Decides whether a choice applies now. May do I/O (a lookup, an LLM call);
 * by convention it does not change the working set.
 */
export type Criteria<State, Data = unknown> = (workingSet: Readonly<State>) => Promise<CriteriaResult<Data>>;

/** Runs for a matched choice. Actions are the only writers of the working set. */
export type Action<State, Data = unknown> = (workingSet: State, match: CriteriaResult<Data>) => Promise<void>;

/** A criterion and the actions to run when it matches. */
export interface Choice<State, Data = unknown> {
  /** Shown in the trace and in error messages. Must be unique within its choice set (across both groups). */
  name: string;
  /** Why this choice exists, carried into the trace beside its name. The loop doesn't interpret it. */
  why?: string;
  criteria: Criteria<State, Data>;
  /** Run in order when the criteria match. */
  actions: Action<State, Data>[];
}

/**
 * The choices for one iteration and how to select among them.
 * - `first`: the first matching choice, in order.
 * - `all`: every matching choice.
 * - `first_else_all`: the first match in `first`; only if there is none, every match in `all`.
 * - `first_then_all`: the first match in `first` and every match in `all`.
 *
 * Every mode selects before any action runs, so all choices in an iteration see
 * the same working set. Selected actions then run in order (`first` before `all`).
 */
export type ChoiceSet<State> =
  | { name?: string; mode: 'first' | 'all'; choices: Choice<State, any>[] }
  | { name?: string; mode: 'first_else_all' | 'first_then_all'; first: Choice<State, any>[]; all: Choice<State, any>[] };

/**
 * Given the working set, the choices that make sense now, or `null` for nothing to offer.
 * Called again after every unfinished iteration; may return a different set each time. In a
 * `chain`, `null` hands the iteration to the next provider; as the agent's provider, `null`
 * ends the run `failed`.
 */
export type ChoiceProvider<State> = (workingSet: Readonly<State>) => Promise<ChoiceSet<State> | null>;

/** Builds the working set for one subject. */
export type Initializer<Subject, State> = (subject: Subject) => State | Promise<State>;

/** Checked before each provider call; true ends the run as `completed`. May be sync or async. */
export type FinishChecker<State> = (workingSet: Readonly<State>) => boolean | Promise<boolean>;

/**
 * The run's result, from the final working set of a `completed` or `no_match` run. A
 * finalizer that throws ends the run `failed`.
 */
export type Finalizer<State, Result> = (workingSet: Readonly<State>) => Result | Promise<Result>;

/** Each criterion of one iteration that returned a valid result, in order, `data` included. */
export interface CriterionMatch {
  choice: string;
  result: CriteriaResult;
}

/**
 * What to keep of an iteration, called as it ends (a failed one included): the entry, a
 * reshaped entry, or `null` to keep nothing for it. A tracer that throws ends the run
 * `failed`, unless the iteration had already failed: then the run keeps its own error,
 * and that entry is kept as is.
 */
export type Tracer<Entry> = (entry: TraceEntry, context: { matches: CriterionMatch[] }) => Entry | null | undefined;

/** What makes the agent this agent. */
export interface AgentEssentials<Subject, State, Result = State> {
  initializer: Initializer<Subject, State>;
  choiceProvider: ChoiceProvider<State>;
  finishChecker: FinishChecker<State>;
  /** Default: the working set itself. */
  finalizer?: Finalizer<State, Result>;
}

/** The incidentals. */
export interface AgentOptions<Entry = TraceEntry> {
  /** Default: keep every entry as is. `false` keeps no trace at all. */
  tracer?: false | Tracer<Entry>;
  /** Guard against a run that never finishes: a positive integer. Default 25. */
  maxIterations?: number;
}

/** A criterion that ran: whether it matched (with its `detail`), or the error it threw (or the bad result it returned). */
export type EvaluatedChoice =
  | { choice: string; matched: boolean; why?: string; detail?: unknown }
  | { choice: string; error: string; why?: string };

/**
 * One iteration, as the loop saw it: the default trace entry, and what a tracer
 * receives. It is started after the finished check, before the provider call, filled in as
 * the iteration runs, and kept as the iteration ends, so an iteration that fails leaves a
 * partial entry marked `failed`. A `no_match` iteration is recorded with `fired: []`. The
 * iteration guard adds no entry.
 */
export interface TraceEntry {
  iteration: number;
  /** The choice set's `name`, or `set <iteration>` when it has none or the provider failed. */
  set: string;
  /** The set's mode, once the provider has returned one. */
  mode?: string;
  /** Selected choices whose actions all completed. */
  fired: string[];
  durationMs: number;
  /** Every criterion that ran, in order, across both groups of a combined set. */
  evaluated: EvaluatedChoice[];
  /**
   * Choices whose criteria never ran: after a `first` match, a skipped fallback, or a failure.
   * Each name once. Empty when the set's mode is unknown, because its groups are then unknown.
   */
  unevaluated: string[];
  /** Each action that completed: its choice, and its index within the choice's actions. */
  executed: { choice: string; action: number }[];
  /** Present only on the entry of the iteration that failed. */
  failed?: true;
}

/**
 * How a run ended. Best effort: `run` never rejects for an error inside the run.
 * - `completed`: the finish checker returned true.
 * - `no_match`: a choice set selected nothing, so the run cannot make progress.
 * - `failed`: something threw (`error` names the source by the part's name: `initializer`,
 *   `finishChecker`, `finalizer`, `tracer`, `iteration <n> choiceProvider`, `<set>/<choice>
 *   criteria` or `action`), the provider returned no choice set, or the iteration guard
 *   tripped (`error` is an `IterationLimitError`). `workingSet` is as the error left it, or
 *   `null` if the initializer failed. A failed run has no `result`.
 * `trace` holds what the tracer kept (by default, every entry).
 */
export type Outcome<State, Result = State, Entry = TraceEntry> =
  | { status: 'completed' | 'no_match'; result: Result; workingSet: State; trace: Entry[] }
  | { status: 'failed'; error: RunError<Entry>; workingSet: State | null; trace: Entry[] };

/** The error of a `failed` run: its source is named in the message, and it carries the trace. */
export interface RunError<Entry = TraceEntry> extends Error {
  trace: Entry[];
}

/** A BelayKit agent: configured once, run per subject. */
export class Agent<Subject, State, Result = State, Entry = TraceEntry> {
  /**
   * Throws a `TypeError` when the essentials aren't an object (options may be left out or `null`);
   * for a key either argument doesn't take, naming it and, for an option among the essentials
   * (or the reverse), the argument it belongs in; and for a part of the wrong kind, naming it:
   * `initializer`, `choiceProvider` and `finishChecker` must be functions, `finalizer` a function
   * if given, `tracer` a function or `false`, and `maxIterations` a positive integer.
   */
  constructor(essentials: AgentEssentials<Subject, State, Result>, options?: AgentOptions<Entry>);
  /**
   * Runs one subject and always resolves. It ends `failed` when the initializer, the
   * provider, the finish checker, a criterion or an action throws; when the provider returns
   * no choice set, or a set has an unknown mode, is missing a group, holds something that isn't a choice
   * with a string `name` and a function `criteria`, or repeats a choice name; when a criterion
   * returns anything but `{ matched: boolean }`; when the finalizer or the tracer throws;
   * or when the iteration guard trips.
   * The loop stops at the first error; isolating per unit of work is the agent's job.
   */
  run(subject: Subject): Promise<Outcome<State, Result, Entry>>;
}

/** Its `trace` holds what the tracer kept, so its type is the agent's. */
export class IterationLimitError extends Error {
  constructor(maxIterations: number, trace: unknown[]);
  trace: unknown[];
}
