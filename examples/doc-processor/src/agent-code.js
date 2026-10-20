// The agent written with @belaykit/core alone: a choice provider picks each step from the
// working set — segment, check, then review the snippet waiting for it, or classify the
// next one — until every snippet is settled. Compare agent-rulebook.js, which makes the
// same decisions in a rulebook.
import { Agent, always } from '@belaykit/core';
import {
  checkChoices, classifierFor, classifyAt, compactTrace, dropUnknownTopics, finalize, flagAmbiguity, flagNewThemes,
  initialWorkingSet, isAmbiguous, isDocumentDone, markReviewed, newThemes, nextToClassify, pendingReview, segment,
  unknownTopics,
} from './steps.js';

// Configured once per topic map; run once per document.
export function makeCodeProcessor(map, deps = {}, { maxIterations = 200 } = {}) {
  return new Agent({
    initializer: (document) => ({ ...initialWorkingSet(map, document), segmentation: null }),
    choiceProvider: makeProvider(classifierFor(map, deps), deps),
    finishChecker: isDocumentDone,
    finalizer: finalize,
  }, { tracer: compactTrace, maxIterations });
}

function makeProvider(classifier, deps) {
  return async (ws) => {
    if (ws.segmentation === null) return { name: 'segment', mode: 'first', choices: [segmentChoice(deps)] };
    if (ws.accepted === null) return { name: 'check', mode: 'first', choices: checkChoices({ resegment: (current) => { current.segmentation = null; } }) };
    const reviewing = pendingReview(ws);
    if (reviewing !== -1) return { name: 'review', mode: 'all', choices: reviewChoices(reviewing) };
    return { name: 'classify', mode: 'first', choices: [classifyChoice(nextToClassify(ws), classifier)] };
  };
}

const segmentChoice = (deps) => ({
  name: 'segment',
  criteria: always,
  actions: [async (ws) => { ws.segmentation = await segment(ws, deps); }],
});

const about = (index, matched) => ({ matched, detail: { snippet: index } });

const classifyChoice = (index, classifier) => ({
  name: 'classify',
  criteria: async () => about(index, true),
  actions: [async (ws) => classifyAt(ws, index, classifier)],
});

// Every check sees the snippet as classified; the actions then apply in order.
const reviewChoices = (index) => [
  { name: 'drop_unknown_topics', criteria: async (ws) => about(index, unknownTopics(ws, index).length > 0), actions: [async (ws) => dropUnknownTopics(ws, index)] },
  { name: 'flag_ambiguity', criteria: async (ws) => about(index, isAmbiguous(ws, index)), actions: [async (ws) => flagAmbiguity(ws, index)] },
  { name: 'flag_new_themes', criteria: async (ws) => about(index, newThemes(ws, index).length > 0), actions: [async (ws) => flagNewThemes(ws, index)] },
  { name: 'mark_reviewed', criteria: async () => about(index, true), actions: [async (ws) => markReviewed(ws, index)] },
];
