// Type-check fixture for belaykit's .d.ts, compiled by `pnpm run check:types` under `bundler`
// and `nodenext` resolution. Never run. belaykit's types must be the core's own: assignable
// both ways, and strict (each @ts-expect-error is a usage they must reject, so `any` fails).
import { Agent, always, chain, IterationLimitError, version } from 'belaykit';
import type { ChoiceSet, Outcome } from 'belaykit';
import * as core from '@belaykit/core';

const sameAgent: typeof core.Agent = Agent;
const sameAlways: typeof core.always = always;
const sameChain: typeof core.chain = chain;
const sameLimit: typeof core.IterationLimitError = IterationLimitError;
const backAgent: typeof Agent = core.Agent;
const ownVersion: string = version;

interface State {
  done: boolean;
}

const finish: ChoiceSet<State> = {
  name: 'finish',
  mode: 'first',
  choices: [{ name: 'done', criteria: always, actions: [async (ws) => { ws.done = true; }] }],
};
const asCore: core.ChoiceSet<State> = finish;

const agent = new Agent<string, State>({
  initializer: () => ({ done: false }),
  choiceProvider: async () => finish,
  finishChecker: (ws) => ws.done,
});
const outcome: Promise<core.Outcome<State>> = agent.run('hello');
const asBelaykit: Promise<Outcome<State>> = outcome;

// @ts-expect-error: a choice set's mode is one of the four
const badMode: ChoiceSet<State> = { name: 'x', mode: 'some', choices: [] };

// @ts-expect-error: the subject is a string
agent.run(42);

export { sameAgent, sameAlways, sameChain, sameLimit, backAgent, ownVersion, asCore, asBelaykit, badMode };
