# belaykit

**BelayKit** under its plain name. This package re-exports [`@belaykit/core`](https://github.com/csepulv/belaykit/tree/main/packages/core):
the same `Agent`, `chain`, `always` and `IterationLimitError`, with the core as its only dependency (its `version` is its own). Install
whichever name you prefer; the docs use `@belaykit/core`.

```bash
npm install belaykit
```

```js run
import { Agent, always } from 'belaykit';

const agent = new Agent({
  initializer: (subject) => ({ subject, done: false }),
  choiceProvider: async () => ({ name: 'finish', mode: 'first', choices: [{ name: 'done', criteria: always, actions: [async (ws) => { ws.done = true; }] }] }),
  finishChecker: (ws) => ws.done,
});

console.log((await agent.run('hello')).status);
```

```text output
completed
```

Rulebooks are a separate package, [`@belaykit/rulebook`](https://github.com/csepulv/belaykit/tree/main/packages/rulebook).
Start with [Getting started](https://github.com/csepulv/belaykit/blob/main/documentation/getting-started.md).

## License

MIT
