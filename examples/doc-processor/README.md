# doc-processor

BelayKit's example agent. Given a document, it extracts the snippets (self-contained notes, ideas, questions, tasks,
reviews, quotes), places each in a topic map, and types it from a set of options. Anything the model returns outside
the map is flagged for review. It's written twice, once with `@belaykit/core` alone and once with a rulebook, and the
two give the same answer, so you can compare how each way writes the same decisions.

It's generalized from the agent BelayKit was first built for, which files voice-memo summaries into a knowledge base.
This one keeps the shape and drops the specifics: no Notion, no particular document format.

New to BelayKit? [Getting started](../../documentation/getting-started.md) builds a small agent both ways, then walks through
this one; [Concepts](../../documentation/concepts.md) explains the parts.

## Run it

Offline, on recorded model answers (no key, no network), from the repo root:

```bash
pnpm install
pnpm --filter doc-processor test
```

Live, on your own document (needs `ANTHROPIC_API_KEY`; the model is `claude-sonnet-5-5` unless
`DOC_PROCESSOR_MODEL` says otherwise):

```bash
cd examples/doc-processor
node src/cli.js samples/music-notes.md               # the code-only version
node src/cli.js samples/music-notes.md --rulebook    # the rulebook version
node src/cli.js my-notes.md --map my-topic-map.yaml  # your own topic map
```

It prints the result as JSON: each snippet with its `topics`, `type` and `themes` (or its `error`), the `flags` for
review, and `failed` with the reasons when the document couldn't be segmented.

The command sizes the agent's iteration limit to the document (two iterations per snippet). The agent's own default,
for code that calls `makeCodeProcessor` or `makeRulebookProcessor` directly, is 200 iterations, about 98 snippets; pass
`{ maxIterations }` as the third argument for longer documents.

## How it works

One run per document, in four steps, each step decided anew on every iteration:

1. **Segment.** The model sees the document with numbered lines and returns structure only: which lines make each
   snippet, which are headings, which to skip. It never returns text (`src/segment.js`). Headings are Markdown's
   `#` to `######` lines, and `---` is a rule; anything else is content.
2. **Check.** Code checks that every non-blank line is labelled once and truthfully. If not, it asks again with the
   reasons; a second failure fails the document. Accepted, each snippet's text is sliced from the document, so it's
   literal, and its header is the nearest heading above it, also read from the document
   (`src/build-snippets.js`).
3. **Classify** the next snippet against the map (`src/classify.js`). A call that fails marks that snippet with its
   error, and the run goes on.
4. **Review** it as soon as it's classified: drop topics outside the map, flag an ambiguity, flag new themes.

The steps themselves are shared (`src/steps.js`); the two versions differ only in how they decide which step comes
next:

- **`src/agent-code.js`**, `@belaykit/core` alone: a choice provider looks at the working set and returns the next
  choice set.
- **`src/agent-rulebook.js`** with **`rules/doc-processor.rules.yaml`**: the rulebook gathers the segmentation, then
  classifies and reviews each snippet with `selectFirst`, using two functions from `src/registry.js` (`doc_waiting`,
  `doc_outside`; see `rules/functions.md`). The code check follows the rulebook in a `chain`, and on a re-segment has
  the rulebook gather the segmentation again with `rules.regather`.

## Where each BelayKit idea shows

| Idea | Where |
| --- | --- |
| An agent: `new Agent(essentials, options)`, configured once per topic map, run per document | `makeCodeProcessor`, `makeRulebookProcessor` |
| A choice provider that picks the next step from the working set | `agent-code.js`, `makeProvider` |
| Choice sets in `first` and `all` modes; criteria that report a `detail` | `agent-code.js` |
| A finalizer (the result) and a tracer (a compact trace) | `steps.js`, `finalize` and `compactTrace` |
| Best effort: one snippet's failure doesn't end the run | `steps.js`, `classifyAt` |
| A rulebook: sections, rules, hit policies, `selectFirst`, `needs` | `rules/doc-processor.rules.yaml` |
| A registry: producers, actions, CEL functions, initial keys | `src/registry.js` |
| A guarded action: no rulebook edit can classify (call the model) before the code check accepts the segmentation | `src/registry.js`, `classify_snippet`'s `guard` |
| A templated param: the ambiguity flag's wording lives in the rulebook, filled from the selected snippet | `flag_ambiguity`'s `templates`, and its rule in `rules/doc-processor.rules.yaml` |
| `chain`: a rulebook handing the gap to code | `agent-rulebook.js` |
| `rules.regather`: asking for a gathered key again | `agent-rulebook.js`, `makeCheckProvider` |
| Checking a rulebook before it runs | `pnpm run check` (`belaykit-rulebook check`) |
| A function reference from the registry | `pnpm -s run reference > rules/functions.md` (a test keeps it in step) |
| Fixture runs: a rulebook's decisions pinned in text | `fixtures/review-flags.yaml`, `__tests__/rulebook-checks.test.js` |

## Files

- `samples/`: the topic map (photography, books, music, movies; themes; types) and two documents.
- `__tests__/recorded/`: the model answers the tests use, one file per sample document.
- `__tests__/processor-contract.js`: what both versions must do, run against each.
- `src/llm.js`: the live model call (Anthropic, structured output); the agents take it as `deps.askJson`.
