// The agent's domain steps, shared by both versions: the code-only agent calls them from
// its choices, the rulebook version from its registry. Only the decisions about when to
// call them differ between the two. Actions are the only writers of the working set.
import { buildSnippets, checkSegmentation } from './build-snippets.js';
import { buildSystemPrompt, classificationSchemaFor, classifySnippet } from './classify.js';
import { segmentDocument } from './segment.js';
import { topicSlugs } from './topic-map.js';

// One retry: a segmentation that fails the check is asked for once more, with the reasons.
const MAX_RETRIES = 1;

// What every run starts from; the document is the run's subject.
export const initialWorkingSet = (map, document) => ({
  document,
  topic_slugs: topicSlugs(map),
  theme_slugs: map.themes,
  retries: 0,
  feedback: [],
  snippets: [],
  flags: [],
  accepted: null,
  failed: null,
});

// What the classifier needs for a whole run: the prompt and schema come from the map.
export const classifierFor = (map, deps) => ({
  askJson: deps.askJson,
  systemPrompt: buildSystemPrompt(map),
  schema: classificationSchemaFor(map),
});

// Done when the document failed, or every snippet is reviewed or carries its error.
export const isDocumentDone = (ws) => ws.failed !== null || (ws.accepted === true && ws.snippets.every(isSettled));
const isSettled = (snippet) => snippet.reviewed || snippet.error !== null;

// A failed call (refusal, schema miss) comes back as a segmentation the check refuses, so it
// is retried or fails the document like any other bad answer.
export async function segment(ws, deps) {
  try {
    return await segmentDocument(ws.document, { feedback: ws.feedback }, deps);
  } catch (error) {
    return { callError: error.message };
  }
}

const segmentationErrors = (ws) => (ws.segmentation.callError
  ? [`segmenter call failed: ${ws.segmentation.callError}`]
  : checkSegmentation(ws.document, ws.segmentation));

// accept | re-segment | fail, each matching on its own terms. `resegment` has the
// segmentation asked for again: the code version clears it; the rulebook version has its
// rulebook gather it again.
export const checkChoices = ({ resegment }) => [
  {
    name: 'accept',
    criteria: async (ws) => ({ matched: segmentationErrors(ws).length === 0 }),
    actions: [async (ws) => {
      ws.snippets = buildSnippets(ws.document, ws.segmentation);
      ws.accepted = true;
    }],
  },
  {
    name: 're-segment',
    criteria: async (ws) => {
      const errors = segmentationErrors(ws);
      return { matched: errors.length > 0 && ws.retries < MAX_RETRIES, data: { errors } };
    },
    actions: [async (ws, match) => {
      ws.retries += 1;
      ws.feedback = match.data.errors;
      resegment(ws);
    }],
  },
  {
    name: 'fail',
    criteria: async (ws) => {
      const errors = segmentationErrors(ws);
      return { matched: errors.length > 0 && ws.retries >= MAX_RETRIES, data: { errors } };
    },
    actions: [async (ws, match) => { ws.failed = { errors: match.data.errors }; }],
  },
];

// The snippet waiting for review, if any, and the next one to classify.
export const pendingReview = (ws) => ws.snippets.findIndex((snippet) => snippet.classification !== null && !snippet.reviewed);
export const nextToClassify = (ws) => ws.snippets.findIndex((snippet) => snippet.classification === null && snippet.error === null);

// Snippets are replaced, not mutated, so a snippet the rulebook selected stays as it was seen.
const replaceSnippet = (ws, index, change) => {
  ws.snippets = ws.snippets.map((snippet, position) => (position === index ? { ...snippet, ...change(snippet) } : snippet));
};
const flag = (ws, index, reason) => { ws.flags = [...ws.flags, { snippet: ws.snippets[index].n, reason }]; };

// One snippet's failed call marks that snippet and the run goes on.
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

// A topic or theme the model names twice counts once.
const withoutRepeats = (classification) => ({
  ...classification,
  topics: [...new Set(classification.topics)],
  themes: [...new Set(classification.themes)],
});

export const unknownTopics = (ws, index) => ws.snippets[index].classification.topics.filter((topic) => !ws.topic_slugs.includes(topic));
export const newThemes = (ws, index) => ws.snippets[index].classification.themes.filter((theme) => !ws.theme_slugs.includes(theme));
export const isAmbiguous = (ws, index) => ws.snippets[index].classification.ambiguity !== '';

export function dropUnknownTopics(ws, index) {
  const unknown = unknownTopics(ws, index);
  for (const topic of unknown) flag(ws, index, `unknown topic: ${topic}`);
  replaceSnippet(ws, index, ({ classification }) => ({ classification: { ...classification, topics: classification.topics.filter((topic) => !unknown.includes(topic)) } }));
}

export const flagAmbiguity = (ws, index) => flag(ws, index, `ambiguous: ${ws.snippets[index].classification.ambiguity}`);
// The rulebook version writes the wording itself, a templated param filled from the snippet.
export const flagSnippet = (ws, index, reason) => flag(ws, index, reason);

export function flagNewThemes(ws, index) {
  for (const theme of newThemes(ws, index)) flag(ws, index, `new theme: ${theme}`);
}

export const markReviewed = (ws, index) => replaceSnippet(ws, index, () => ({ reviewed: true }));

// The agent's result: every snippet, placed and typed (or with its error), the flags for
// review, and why the document failed, if it did.
export const finalize = (ws) => ({
  snippets: ws.snippets.map(({ n, header, text, classification, error }) => ({
    n,
    header,
    text,
    topics: classification?.topics ?? [],
    type: classification?.type ?? null,
    themes: classification?.themes ?? [],
    error,
  })),
  flags: ws.flags,
  failed: ws.failed,
});

// The agent's trace: each iteration's step, what fired, and which snippet it was about.
export const compactTrace = (entry) => {
  const selected = entry.evaluated.find(({ detail }) => detail?.snippet !== undefined)?.detail.snippet;
  return { set: entry.set, fired: entry.fired, ...(selected !== undefined && { snippet: Number(selected) }) };
};
