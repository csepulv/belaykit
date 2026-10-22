// What doc-processor.rules.yaml may name: its producer, its actions, and the working-set keys
// the agent sets. Each entry calls the same step the code-only agent uses (steps.js).
// Producers run(ws, deps) and return their needs key's value; actions run(ws, { params,
// deps, selected }), where `selected` is the snippet a rule's selectFirst picked. The shape of
// ws.snippets is the snippet's own zod schema, so the rulebook's field reads are checked at load.
//
// Two entries hold their own rules: classify_snippet's guard (it calls the model, and only the
// code check accepts a segmentation, so no rulebook edit can classify a document that wasn't
// accepted), and flag_ambiguity's templated `reason` (the rulebook writes the flag's wording).
import { z } from 'zod';
import { snippetSchema } from './build-snippets.js';
import {
  classifyAt, dropUnknownTopics, flagNewThemes, flagSnippet, markReviewed, segment,
} from './steps.js';

const onSelected = (step) => async (ws, { selected }) => step(ws, selected.index);

export const registry = {
  producers: {
    segment_document: { writes: ['segmentation'], run: (ws, deps) => segment(ws, deps) },
  },
  actions: {
    classify_snippet: {
      writes: ['snippets', 'flags'],
      guard: 'ws.accepted == true',
      run: async (ws, { selected, deps }) => classifyAt(ws, selected.index, deps.classifier),
    },
    drop_unknown_topics: { writes: ['snippets', 'flags'], run: onSelected(dropUnknownTopics) },
    flag_ambiguity: {
      writes: ['flags'],
      params: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      templates: ['reason'],
      run: async (ws, { selected, params }) => flagSnippet(ws, selected.index, params.reason),
    },
    flag_new_themes: { writes: ['flags'], run: onSelected(flagNewThemes) },
    mark_reviewed: { writes: ['snippets'], run: onSelected(markReviewed) },
  },
  functions: [{
    signature: 'doc_waiting(map, list): bool',
    handler: (snippet, snippets) => snippets.find((candidate) => candidate.classification !== null && !candidate.reviewed)?.n === snippet.n,
    description: 'True when the snippet is the one waiting for review: the first classified snippet not yet reviewed.',
    params: [{ name: 'snippet', description: 'A snippet from the working set' }, { name: 'snippets', description: 'All of the run\'s snippets' }],
  }, {
    signature: 'doc_outside(list, list): bool',
    handler: (items, known) => items.some((item) => !known.includes(item)),
    description: 'True when any item of the first list is missing from the second: a topic or theme outside the map.',
    params: [{ name: 'items', description: 'What the classifier returned' }, { name: 'known', description: 'What the map holds' }],
  }],
  initialKeys: ['document', 'topic_slugs', 'theme_slugs', 'retries', 'feedback', 'snippets', 'flags', 'accepted', 'failed'],
  shapes: { snippets: z.toJSONSchema(z.array(snippetSchema)) },
};
