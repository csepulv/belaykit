// A rulebook as a decision function (since 0.2): run it on the core's Agent until every
// output it declares is present, and say why when it can't. `no_match` means nothing applied (no
// section claimed the working set, or one claimed and no rule held); `failed` means something broke.
import { Agent } from '@belaykit/core';
import { initialWorkingSet, isPresent, rulebookProvider } from './provider.js';

// The set a no-claim becomes, so the run ends `no_match` (an empty choice set) rather than the
// core's `failed` for a provider that passes.
const NO_SECTION = { name: 'no section', mode: 'first', choices: [] };

export async function decide({ loaded, registry, initial = {}, deps, maxIterations }) {
  const { outputs } = loaded;
  const provider = rulebookProvider(loaded, registry, deps);
  const outcome = await new Agent({
    initializer: () => {
      const present = outputs.find((output) => isPresent(initial, output));
      if (present !== undefined) throw new TypeError(`decide: output "${present}" is already present`);
      return initialWorkingSet(loaded, initial);
    },
    choiceProvider: async (ws) => (await provider(ws)) ?? NO_SECTION,
    finishChecker: (ws) => outputs.every((output) => isPresent(ws, output)),
  }, maxIterations === undefined ? {} : { maxIterations }).run();

  const { status, trace } = outcome;
  if (status === 'completed') return { status, outputs: Object.fromEntries(outputs.map((output) => [output, outcome.workingSet[output]])), trace };
  if (status === 'no_match') return { status, error: noDecisionMessage(loaded, outcome.workingSet), trace };
  return { status, error: outcome.error.message, trace };
}

// Which outputs are unset, and the sections as the provider asked them on the final working set: in
// order, up to the first whose `when` holds (it claimed, and had nothing that applied); the rest weren't
// reached. (A `when` that throws or isn't a boolean would have failed the run, not ended it `no_match`.)
function noDecisionMessage({ outputs, sections, env }, ws) {
  const unset = outputs.filter((output) => !isPresent(ws, output));
  const claimed = sections.findIndex((section) => env.evaluate(section.when, { ws }) === true);
  const described = sections.map((section, index) => {
    if (claimed !== -1 && index > claimed) return `${section.name} (not reached)`;
    if (index < claimed || claimed === -1) return `${section.name} (when false)`;
    return `${section.name} (when true, ${section.rules.length ? 'no rule held' : 'nothing left to gather'})`;
  });
  return `decide: no section decided; unset outputs: ${unset.join(', ')}; sections: ${described.join(', ')}`;
}
