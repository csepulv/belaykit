---
title: Getting started
---

# Getting started

This page builds a small agent twice, once in code and once with a rulebook, then walks through the example agent in
this repository, which does real work with a model. [Concepts](concepts.md) explains each part in more depth.

## Install

BelayKit needs Node.js 20.19 or later (the version the rulebook package's CEL evaluator requires).

```bash
npm install @belaykit/core
npm install @belaykit/rulebook   # only if you write rulebooks
```

BelayKit is ES modules only, and the examples use `import` and top-level `await`. Save them as `.mjs` files, or set
`"type": "module"` in your `package.json` and use `.js`.

## A first agent, in code

The agent takes a short note and types each line: a question, a task, or a note. It's the shape most BelayKit agents
have: a working set with several items, a provider that picks the next item to work on, and a finish checker that's
satisfied when every item is done.

```js run
import { Agent } from '@belaykit/core';

const guessType = (text) => (text.endsWith('?') ? 'question' : text.startsWith('buy ') ? 'task' : 'note');

const agent = new Agent({
  // The subject is the note; the working set is its lines, untyped.
  initializer: (note) => ({ items: note.split('\n').filter(Boolean).map((text) => ({ text, type: null })) }),
  // Each iteration types the next untyped line.
  choiceProvider: async (ws) => {
    const index = ws.items.findIndex((item) => item.type === null);
    return {
      name: 'type',
      mode: 'first',
      choices: [{
        name: 'type-next',
        criteria: async () => ({ matched: true, detail: { item: index } }),
        actions: [async (current) => { current.items[index].type = guessType(current.items[index].text); }],
      }],
    };
  },
  finishChecker: (ws) => ws.items.every((item) => item.type !== null),
  finalizer: (ws) => ws.items.map(({ text, type }) => `${type}: ${text}`),
});

const outcome = await agent.run('buy film\nthe light was good today\nwhich lens for portraits?');
console.log(outcome.status);
console.log(outcome.result.join('\n'));
```

```text output
completed
task: buy film
note: the light was good today
question: which lens for portraits?
```

`run` never rejects: had an action thrown, the outcome would be `failed`, with an `error` naming the choice and the
trace of what happened so far.

## The same agent, with a rulebook

A rulebook writes the decisions as text. The YAML below decides the same types as the provider above, though not in
the same order: while some line is untyped, the first rule that holds types the first line it matches. The code that does the work (setting a
type) lives in a **registry** the rulebook is checked against when it loads.

```js run
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

const RULEBOOK = `
version: 1
sections:
  - name: type
    when: ws.items.exists(i, i.type == null)
    exhaustive: false                       # its when holds only while an item waits, so a rule always matches
    rules:
      - id: question
        selectFirst: { item: ws.items }
        when: item.type == null && item.text.endsWith("?")
        then: { action: set_type, type: question }
      - id: task
        selectFirst: { item: ws.items }
        when: item.type == null && item.text.startsWith("buy ")
        then: { action: set_type, type: task }
      - id: note
        selectFirst: { item: ws.items }
        when: item.type == null
        then: { action: set_type, type: note }
`;

const registry = {
  producers: {},
  actions: {
    set_type: {
      writes: ['items'],
      params: { type: 'object', properties: { type: { enum: ['question', 'task', 'note'] } }, required: ['type'], additionalProperties: false },
      run: async (ws, { params, selected }) => {
        ws.items = ws.items.map((item, index) => (index === selected.index ? { ...item, type: params.type } : item));
      },
    },
  },
  initialKeys: ['items'],
};

const rules = Rulebook.fromText(RULEBOOK, registry); // throws, listing every problem, if the text is wrong
const agent = new Agent({
  initializer: (note) => rules.initialize({ items: note.split('\n').filter(Boolean).map((text) => ({ text, type: null })) }),
  choiceProvider: rules.provider(),
  finishChecker: (ws) => ws.items.every((item) => item.type !== null),
  finalizer: (ws) => ws.items.map(({ text, type }) => `${type}: ${text}`),
});

console.log((await agent.run('buy film\nthe light was good today\nwhich lens for portraits?')).result.join('\n'));
```

```text output
task: buy film
note: the light was good today
question: which lens for portraits?
```

`selectFirst: { item: ws.items }` binds `item` to each line in turn, and the rule matches on the first line for which
its `when` holds; the action gets that line's index as `selected.index`. Each rule selects on its own, so the
question rule may type line 3 before the note rule types line 2. The result is the same, but if several rules must
act on *the same* item, say which one in each `when` ([Rulebooks](rulebooks.md#selectfirst) shows how).

A `FIRST` section with rules must say what happens when none of them holds: it ends in a rule that always holds, or,
like this one, says `exhaustive: false`, that it needs no catch-all. Here the section's `when` holds only while some
line is untyped, and the last rule types any such line ([When no rule holds](rulebooks.md#when-no-rule-holds)).

Loading checks the rulebook against the registry before anything runs: an action the registry doesn't have, a param
the action doesn't take, CEL that doesn't compile, a `ws.` key nothing declares. Give the registry a `shapes` entry for
`items` (a JSON Schema; with zod, `z.toJSONSchema` of your schema) and a misspelled `item.text` is refused too
([Rulebooks](rulebooks.md#shapes)). `Rulebook.check(text, registry)` returns the same problems as a list, and
`npx belaykit-rulebook check` runs it on files.

## The example agent

[`examples/doc-processor`](https://github.com/csepulv/belaykit/tree/main/examples/doc-processor) is a complete agent
built the same two ways. Given a document, it extracts the **snippets** (self-contained notes, ideas, questions,
tasks, reviews, quotes), places each in a **topic map**, and types it, using a model. Anything the model returns
outside the map is flagged for review. Its tests run offline on recorded model answers:

```bash
git clone https://github.com/csepulv/belaykit && cd belaykit
pnpm install
pnpm --filter doc-processor test
```

and, with an `ANTHROPIC_API_KEY`, it runs on your own documents:

```bash
cd examples/doc-processor
node src/cli.js samples/music-notes.md               # the code-only version
node src/cli.js samples/music-notes.md --rulebook    # the rulebook version
```

### In code

The provider looks at the working set and decides the next step: segment the document, check the segmentation,
review the snippet that was just classified, or classify the next one.

```js fragment examples/doc-processor/src/agent-code.js
function makeProvider(classifier, deps) {
  return async (ws) => {
    if (ws.segmentation === null) return { name: 'segment', mode: 'first', choices: [segmentChoice(deps)] };
    if (ws.accepted === null) return { name: 'check', mode: 'first', choices: checkChoices({ resegment: (current) => { current.segmentation = null; } }) };
    const reviewing = pendingReview(ws);
    if (reviewing !== -1) return { name: 'review', mode: 'all', choices: reviewChoices(reviewing) };
    return { name: 'classify', mode: 'first', choices: [classifyChoice(nextToClassify(ws), classifier)] };
  };
}
```

The review is an `all`-mode set: each check runs against the snippet as classified, and every one that matches acts.
Classifying is where the model is called, and one snippet's failure doesn't end the run: the step catches it, marks
that snippet with its error, flags it, and the run goes on to the next.

```js fragment examples/doc-processor/src/steps.js
export async function classifyAt(ws, index, classifier) {
  try {
    const classification = await classifySnippet(ws.snippets[index], classifier);
    replaceSnippet(ws, index, () => ({ classification: withoutRepeats(classification) }));
  } catch (error) {
    const message = `classify failed: ${error.message}`;
    replaceSnippet(ws, index, () => ({ error: message }));
    flag(ws, index, message);
  }
}
```

### With a rulebook

The rulebook version makes the same decisions in
[`rules/doc-processor.rules.yaml`](https://github.com/csepulv/belaykit/blob/main/examples/doc-processor/rules/doc-processor.rules.yaml).
Its first section *gathers* the segmentation: a `needs` key filled by a producer in the registry. The review section
uses two functions the registry registers for CEL, so every review rule acts on the snippet waiting for review:

```yaml fragment examples/doc-processor/rules/doc-processor.rules.yaml
  - name: review
    when: ws.accepted == true && ws.snippets.exists(s, doc_waiting(s, ws.snippets))
    hitPolicy: ALL
    rules:
      - id: drop_unknown_topics
        selectFirst: { snippet: ws.snippets }
        when: doc_waiting(snippet, ws.snippets) && doc_outside(snippet.classification.topics, ws.topic_slugs)
        then: { action: drop_unknown_topics }
        why: the classifier named a topic the map doesn't have
```

Checking the segmentation stays in code. The rulebook hands it over with `chain`: once the segmentation is gathered
the rulebook has nothing to offer, and the code check takes the iteration. When the check rejects the segmentation, it
has the rulebook gather it again with `rules.regather`:

```js fragment examples/doc-processor/src/agent-rulebook.js
export function makeRulebookProcessor(map, deps = {}, { maxIterations = 200 } = {}) {
  const rules = Rulebook.load(RULEBOOK, registry);
  return new Agent({
    initializer: (document) => rules.initialize(initialWorkingSet(map, document)),
    choiceProvider: chain([rules.provider({ ...deps, classifier: classifierFor(map, deps) }), makeCheckProvider(rules)]),
    finishChecker: isDocumentDone,
    finalizer: finalize,
  }, { tracer: compactTrace, maxIterations });
}

// The rulebook passes once the segmentation is gathered; the code check takes it from there.
const makeCheckProvider = (rules) => async (ws) => (ws.accepted === null
  ? { name: 'check', mode: 'first', choices: checkChoices({ resegment: (current) => rules.regather(current, 'segmentation') }) }
  : null);
```

Both versions give the same results, and the same trace apart from how the segmentation is gathered (a test checks
both), so you can compare how each way writes the decisions.

### Checking a rulebook before it runs

```bash
cd examples/doc-processor
pnpm run check                                       # belaykit-rulebook check: "rules/doc-processor.rules.yaml: ok"
pnpm -s run reference > rules/functions.md           # BelayKit's helpers and the registry's functions, as Markdown
```

A **fixture** pins what the rulebook decides, without a model: where a run starts, what each producer returns, and how
it should end. The example's
[`fixtures/review-flags.yaml`](https://github.com/csepulv/belaykit/blob/main/examples/doc-processor/fixtures/review-flags.yaml)
starts with three classified snippets and states the flags the review must raise; `rules.runFixture` runs it.

## Next

- [Concepts](concepts.md): the loop, choice sets and modes, outcomes, the trace, and the options.
- [Rulebooks](rulebooks.md): the file format, the registry, checks, fixtures and `regather`.
- The API reference: [`@belaykit/core`](api/core.md) and [`@belaykit/rulebook`](api/rulebook.md).
