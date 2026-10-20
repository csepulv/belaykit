// The agent written with a rulebook: rules/doc-processor.rules.yaml gathers the segmentation
// and decides each snippet's classification and review (with selectFirst); the code check
// (accept | re-segment | fail) follows it in a chain, and has the rulebook gather the
// segmentation again on a re-segment. Compare agent-code.js, which makes the same decisions
// in code.
import { fileURLToPath } from 'node:url';
import { Agent, chain } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';
import { registry } from './registry.js';
import { checkChoices, classifierFor, compactTrace, finalize, initialWorkingSet, isDocumentDone } from './steps.js';

export const RULEBOOK = fileURLToPath(new URL('../rules/doc-processor.rules.yaml', import.meta.url));

// Configured once per topic map; run once per document. Loading checks the rulebook
// against the registry, so a broken rulebook fails here, before any model call.
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
