# @belaykit/rulebook

Rulebooks for **BelayKit**: an agent's decisions written as a YAML file of **sections** and **rules**, with
conditions in CEL. A rulebook is checked when it loads against your agent's **registry** (the producers, actions and
functions it may name, the params each action takes, and the shape of each working-set key), so an unknown action, a
misspelled param or a misspelled field is an error before anything runs. A loaded `Rulebook` gives you a choice
provider for [`@belaykit/core`](https://github.com/csepulv/belaykit/tree/main/packages/core).

```bash
npm install @belaykit/core @belaykit/rulebook
```

```js run
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const rules = Rulebook.fromText(`
version: 1
sections:
  - name: gather
    when: '!has(ws.classification)'
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
`, {
  producers: { classify_item: { writes: ['classification'], run: async (ws, deps) => deps.classify(ws.item) } },
  actions: {
    settle: {
      writes: ['routing'],
      params: { type: 'object', properties: { routing: { enum: ['escalate', 'hold'] } }, required: ['routing'], additionalProperties: false },
      run: async (ws, { params }) => { ws.routing = params.routing; },
    },
  },
  initialKeys: ['item', 'routing'],
});

const agent = new Agent({
  initializer: (item) => rules.initialize({ item, routing: null }),
  choiceProvider: rules.provider({ classify: async (item) => ({ urgent: item.includes('down') }) }),
  finishChecker: (ws) => ws.routing !== null,
  finalizer: (ws) => ws.routing,
});

console.log((await agent.run('server down')).result, (await agent.run('new laptop')).result);
```

```text output
escalate hold
```

## Fixture runs

A fixture pins what a rulebook decides, without calling its producers: where a run starts, what each producer would
return, and how the run should end. For the rulebook above:

```yaml
initial: { item: "server down", routing: null }
produce: { classification: { urgent: true } }
expect: { status: completed, fired: ["gather classification", "urgent"], result: { routing: escalate } }
```

`rules.runFixture({ fixture: loadFixture(path), finishChecker, finalizer })` runs it and returns its `mismatches`,
empty when `expect` holds. The `belaykit-rulebook` command checks rulebook files, and macro files, before you deploy
them:

```bash
npx belaykit-rulebook check rulebooks/*.rules.yaml rulebooks/*.macros.yaml --registry src/registry.js#registry
```

## Learn more

- [Rulebooks](https://github.com/csepulv/belaykit/blob/main/documentation/rulebooks.md): the format, `needs` keys (gathered when present),
  `selectFirst`, CEL, BelayKit's helpers and registered functions, macros (named CEL expressions in files a rulebook
  imports), the registry (guarded actions included), checks, the catch-all rule, fixtures,
  `regather`, and deciding with `rules.decide`.
- [Getting started](https://github.com/csepulv/belaykit/blob/main/documentation/getting-started.md): an agent written in code
  and with a rulebook.
- [API reference](https://github.com/csepulv/belaykit/blob/main/documentation/api/rulebook.md)
- [`examples/doc-processor`](https://github.com/csepulv/belaykit/tree/main/examples/doc-processor): a complete agent
  written both ways.

## License

MIT
