// Type-check fixture for the core's .d.ts contracts, compiled by `pnpm run check:types`
// under `bundler` and `nodenext` resolution. Never run. Each @ts-expect-error is a
// wrong usage the contracts must reject; if one compiles, the check fails.
import { Agent, always, chain, IterationLimitError, version } from '@belaykit/core';

export const coreVersion: string = version;
import type {
  Action, AgentEssentials, AgentOptions, Choice, ChoiceProvider, ChoiceSet, Criteria, CriteriaResult, CriterionMatch,
  EvaluatedChoice, Finalizer, FinishChecker, Initializer, Outcome, RunError, TraceContext, TraceEntry, Tracer,
} from '@belaykit/core';

interface Application {
  score: number;
}

interface State {
  subject: Application;
  approved: boolean | null;
}

const fastTrack: Choice<State, number> = {
  name: 'fast-track',
  why: 'high scores skip review',
  criteria: async (ws) => ({ matched: ws.subject.score > 90, data: ws.subject.score }),
  actions: [async (ws, match) => { ws.approved = (match.data ?? 0) > 90; }],
};

const decide = async (): Promise<ChoiceSet<State>> => ({
  name: 'decide',
  mode: 'first_else_all',
  first: [fastTrack],
  all: [{ name: 'review', criteria: always, actions: [async (ws) => { ws.approved = false; }] }],
});

// A provider may have nothing to offer (null); a chain of them is a provider too.
const passes: ChoiceProvider<State> = async () => null;

const agent = new Agent<Application, State>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: chain<State>([passes, decide]),
  finishChecker: async (ws) => ws.approved !== null,
}, { maxIterations: 5 });

export async function describeRun(): Promise<string> {
  const outcome = await agent.run({ score: 95 });
  if (outcome.status === 'failed') return `${outcome.error.message} after ${outcome.error.trace.length} iterations`;
  const approved: boolean | null = outcome.workingSet.approved;
  return `${outcome.status}: ${approved}`;
}

// A finish checker may be synchronous; the options may be left out.
export const syncFinish = new Agent<Application, State>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: (ws) => ws.approved !== null,
});

// The parts as named types, written out by an author.
const initializer: Initializer<Application, State> = (subject) => ({ subject, approved: null });
const finishChecker: FinishChecker<State> = (ws) => ws.approved !== null;
const lookup: Criteria<State, string> = async () => ({ matched: true, data: 'row-1' });
const record: Action<State, string> = async (ws, match) => { ws.approved = match.data === 'row-1'; };
export const essentials: AgentEssentials<Application, State, State> = { initializer, choiceProvider: decide, finishChecker };
export const options: AgentOptions<TraceEntry> = { tracer: (entry) => entry, maxIterations: 3 };
export const looked: Choice<State, string> = { name: 'lookup', criteria: lookup, actions: [record] };

export const guard = new IterationLimitError(5, []);

// Reading the trace: what each iteration evaluated, never evaluated, and executed.
export function summarize(entry: TraceEntry): string {
  const outcomes = entry.evaluated.map((item: EvaluatedChoice) => ('error' in item ? `${item.choice}!` : `${item.choice}=${item.matched}`));
  const actions = entry.executed.map(({ choice, action }) => `${choice}[${action}]`);
  const stopped = entry.failed === true ? ' (failed)' : '';
  return `${entry.set} ${entry.mode ?? '?'}: ${outcomes.join(' ')} | skipped ${entry.unevaluated.join(',')} | ran ${actions.join(',')}${stopped}`;
}

export function matchedWithoutNarrowing(item: EvaluatedChoice): boolean {
  // @ts-expect-error `matched` exists only on a criterion that returned, not on one that errored
  return item.matched;
}

// @ts-expect-error `why` is a string
export const numericWhy: Choice<State> = { name: 'x', why: 1, criteria: always, actions: [] };

// @ts-expect-error an unknown mode
export const unknownMode: ChoiceSet<State> = { mode: 'any', choices: [] };

// @ts-expect-error a combined-mode set takes `first` and `all`, not `choices`
export const choicesOnCombinedSet: ChoiceSet<State> = { mode: 'first_else_all', choices: [] };

export function readErrorWithoutNarrowing(outcome: Outcome<State>): string {
  // @ts-expect-error `error` exists only on a failed outcome
  return outcome.error.message;
}

export function errorTrace(error: RunError): number {
  return error.trace.length;
}

// The agent's own result and trace.
interface Decision {
  approved: boolean;
}
interface Step {
  set: string;
  score?: unknown;
}

const finalizer: Finalizer<State, Decision> = async (ws) => ({ approved: ws.approved === true });
const tracer: Tracer<Step> = (entry: TraceEntry, { matches }: { matches: CriterionMatch[] }) =>
  (entry.fired.length === 0 ? null : { set: entry.set, score: matches[0]?.result.data });

// Timings are the tracer's to add: they reach it in the context, not in the entry.
export const timed: Tracer<TraceEntry & { durationMs: number }> = (entry, { durationMs }: TraceContext) => ({ ...entry, durationMs });
// @ts-expect-error the default entry has no durationMs
export const untimed = (entry: TraceEntry): number => entry.durationMs;

const decisionAgent = new Agent<Application, State, Decision, Step>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: async (ws) => ws.approved !== null,
  finalizer,
}, { tracer });

export async function readDecision(): Promise<string> {
  const outcome = await decisionAgent.run({ score: 95 });
  if (outcome.status === 'failed') return `${outcome.error.message}; last step ${outcome.error.trace.at(-1)?.set}`;
  const steps: Step[] = outcome.trace;
  return `${outcome.result.approved} after ${steps.length} steps`;
}

export const untraced = new Agent<Application, State>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: async (ws) => ws.approved !== null,
}, { tracer: false });

export const withDetail: Choice<State> = {
  name: 'scored',
  criteria: async (ws) => ({ matched: true, data: ws.subject, detail: { score: ws.subject.score } }),
  actions: [],
};

export function readDetail(item: EvaluatedChoice): unknown {
  return 'error' in item ? null : item.detail;
}

export const detailOf = (match: CriteriaResult): unknown => match.detail;

export async function noResultOnFailure(): Promise<unknown> {
  const outcome = await decisionAgent.run({ score: 10 });
  if (outcome.status !== 'failed') return null;
  // @ts-expect-error a failed outcome has no result property at all
  return outcome.result;
}

export async function resultOfFailedRun(): Promise<boolean> {
  const outcome = await decisionAgent.run({ score: 10 });
  // @ts-expect-error a failed run has no result; narrow on status first
  return outcome.result.approved;
}

export const resultOfWrongType = new Agent<Application, State, Decision>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: async (ws) => ws.approved !== null,
  // @ts-expect-error the finalizer returns the agent's declared Result
  finalizer: (ws) => ws.approved,
});

export const traceOfWrongType = new Agent<Application, State, State, Step>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: async (ws) => ws.approved !== null,
}, {
  // @ts-expect-error the tracer returns the agent's declared Entry (or null)
  tracer: (entry) => entry.iteration,
});

export const optionInEssentials = new Agent<Application, State>({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: decide,
  finishChecker: async (ws) => ws.approved !== null,
  // @ts-expect-error maxIterations is an option, not an essential
  maxIterations: 5,
});

// @ts-expect-error makeAgent is gone; `new Agent(essentials, options)` replaces it
export { makeAgent } from '@belaykit/core';
