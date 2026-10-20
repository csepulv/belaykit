# @belaykit/core

The loop of **BelayKit**: a small library for focused agents, ones with one goal, given one thing to work on, that run
a bounded number of steps and stop with an outcome. No dependencies.

You make an agent from its **essentials** (an initializer that builds the working set, a choice provider that offers
the choices that make sense now, a finish checker, and an optional finalizer), then run it on each subject. Every run
resolves, even when something fails: `completed` or `no_match` with the result, or `failed` with the error, and in
every case the working set and a trace of each step.

```bash
npm install @belaykit/core
```

```js run
import { Agent, always } from '@belaykit/core';

const agent = new Agent({
  initializer: (subject) => ({ subject, approved: null }),
  choiceProvider: async () => ({
    name: 'decide',
    mode: 'first_else_all',
    first: [{ name: 'fast-track', criteria: async (w) => ({ matched: w.subject.score > 90 }), actions: [async (w) => { w.approved = true; }] }],
    all: [{ name: 'review', criteria: always, actions: [async (w) => { w.approved = false; }] }],
  }),
  finishChecker: (ws) => ws.approved !== null,
});

const outcome = await agent.run({ score: 95 });
console.log(outcome.status, outcome.result.approved, outcome.trace.map(({ set, fired }) => `${set}: ${fired}`));
```

```text output
completed true [ 'decide: fast-track' ]
```

## Learn more

- [Getting started](https://github.com/csepulv/belaykit/blob/main/documentation/getting-started.md)
- [Concepts](https://github.com/csepulv/belaykit/blob/main/documentation/concepts.md): the loop, choice sets and modes,
  outcomes, the trace, and the options (`tracer`, `maxIterations`).
- [API reference](https://github.com/csepulv/belaykit/blob/main/documentation/api/core.md)
- [`@belaykit/rulebook`](https://github.com/csepulv/belaykit/tree/main/packages/rulebook): decisions written as YAML +
  CEL rules, as a choice provider for this package.

## License

MIT
