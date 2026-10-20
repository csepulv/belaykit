import type { ChoiceProvider, CriteriaResult } from './decider.js';

/** A criterion that matches any working set, for unconditional steps and fallbacks. */
export function always(): Promise<CriteriaResult<never>>;

/**
 * Compose providers: the first that returns a choice set claims the iteration. A chain is a
 * provider like any other: it returns `null` when none of its providers claims the working set.
 */
export function chain<State>(providers: ChoiceProvider<State>[]): ChoiceProvider<State>;
