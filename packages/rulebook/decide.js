// A rulebook as a decision function (since 0.2): run it on the core's Agent until every
// output it declares is present, with the rule that decided each (since 0.4), and say why when it
// can't. `no_match` means nothing applied (no section claimed the working set, or one claimed and no
// rule held); `failed` means something broke. Every decision shows its declared evidence (since 0.4).
import { Agent } from '@belaykit/core';
import { copyLossOf, isPlainData, kindOfValue, matchesIn } from './plain-data.js';
import { initialWorkingSet, isPresent, rulebookProvider } from './provider.js';

// The set a no-claim becomes, so the run ends `no_match` (an empty choice set) rather than the
// core's `failed` for a provider that passes.
const NO_SECTION = { name: 'no section', mode: 'first', choices: [] };

export async function decide({ loaded, registry, initial = {}, deps, maxIterations, onCopyLoss = 'drop' }) {
  const { outputs } = loaded;
  const writers = new Map();
  // The core asks the provider once per iteration, so its calls count the trace's iterations.
  let iteration = 0;
  let claimed = null;
  const provider = rulebookProvider(loaded, registry, deps, {
    aroundRuleAction: recordWriters(outputs, writers, () => iteration),
    onClaim: (section) => { claimed = section; },
  });
  const outcome = await new Agent({
    initializer: () => {
      const present = outputs.find((output) => isPresent(initial, output));
      if (present !== undefined) throw new TypeError(`decide: output "${present}" is already present`);
      return initialWorkingSet(loaded, initial);
    },
    choiceProvider: async (ws) => {
      iteration += 1;
      return (await provider(ws)) ?? NO_SECTION;
    },
    finishChecker: (ws) => outputs.every((output) => isPresent(ws, output)),
  }, maxIterations === undefined ? {} : { maxIterations }).run();

  const { status, trace, workingSet: ws } = outcome;
  // A failed initializer leaves no working set, so nothing was present.
  const evidence = copiesOf('evidence', loaded.evidence.filter((key) => ws !== null && isPresent(ws, key)), ws, onCopyLoss);
  if (status === 'completed') {
    const copied = copiesOf('output', outputs, ws, onCopyLoss);
    const problems = [...undecidedOutputs(outputs, writers), ...copied.problems, ...evidence.problems];
    if (problems.length > 0) return { status: 'failed', error: problems.join('; '), evidence: evidence.values, trace };
    return {
      status,
      outputs: copied.values,
      decidedBy: Object.fromEntries(outputs.map((output) => [output, writers.get(output)])),
      evidence: evidence.values,
      trace,
    };
  }
  const message = status === 'no_match' ? noDecisionMessage(loaded, ws, claimed) : outcome.error.message;
  // On a no_match run an output may still be present, written by something other than a rule (a registered function
  // that writes ws while a `when` is evaluated, say): the same fault as on a completed one.
  const undecided = status === 'no_match' ? undecidedOutputs(outputs.filter((output) => isPresent(ws, output)), writers) : [];
  const problems = [...undecided, ...evidence.problems];
  return { status: problems.length > 0 ? 'failed' : status, error: [message, ...problems].join('; '), evidence: evidence.values, trace };
}

// Only a rule's action decides an output: the loader refuses one a producer declares it writes, so an output with no
// writer was written by something else (a producer beyond the key it gathers, a registered function), and a decision
// can't say which rule decided it.
const undecidedOutputs = (outputs, writers) => outputs.filter((output) => !writers.has(output))
  .map((output) => `decide: output "${output}" wasn't set by a rule's action (something else wrote it, such as a producer beyond the key it gathers)`);

// Copies, so a caller can't change what the run saw, nor the run what the caller holds (since 0.4). A value that
// can't be copied is a problem naming its key: a class instance anywhere inside it (a copy would drop its class,
// private fields and getters), and whatever stops the walk or structuredClone itself (a function or a symbol, a
// getter that throws, a value nested too deeply). A key structuredClone leaves out without an error (a symbol key,
// say) is dropped, or with `onCopyLoss: 'fail'` is a problem too. `decide` always resolves.
function copiesOf(kind, keys, ws, onCopyLoss) {
  const entries = [];
  const problems = [];
  for (const key of keys) {
    try {
      // The reason is kept as the walk finds it: a value read again (a Proxy, say) may answer otherwise.
      let reason;
      const isRefused = (value) => (reason = whyNotCopied(value, onCopyLoss)) !== undefined;
      const [refused] = matchesIn(ws[key], key, isRefused, 1);
      if (refused === undefined) entries.push([key, structuredClone(ws[key])]);
      else problems.push(`decide: ${kind} "${key}" can't be copied (${refused.path} ${reason})`);
    } catch (error) {
      problems.push(`decide: ${kind} "${key}" can't be copied (${error?.message ?? String(error)})`);
    }
  }
  return { values: Object.fromEntries(entries), problems };
}

// cel-js's uint is a class of its own; an action that stores one can store a number or a BigInt instead.
function whyNotCopied(value, onCopyLoss) {
  if (!isPlainData(value)) {
    const why = value.constructor?.name === 'UnsignedInt' ? 'a CEL uint; store a number or a BigInt' : 'a copy would drop its class, private fields and getters';
    return `is ${kindOfValue(value)}; ${why}`;
  }
  return onCopyLoss === 'fail' ? copyLossOf(value) : undefined;
}

// Around each rule's action: an output it gives a new value (by Object.is) was decided by that rule, in this
// iteration. A change inside an output's own value (a push into a list it holds) isn't a new value.
const recordWriters = (outputs, writers, currentIteration) => async (rule, ws, run) => {
  const before = outputs.map((output) => ws[output]);
  const result = await run();
  outputs.forEach((output, index) => {
    if (!Object.is(ws[output], before[index])) writers.set(output, { ...rule, iteration: currentIteration() });
  });
  return result;
};

// Which outputs are unset, and the sections as the provider asked them in the last iteration: in order, up to the
// one that claimed (it had nothing that applied), those before it false; the rest weren't reached. The provider
// reported the claiming section (`onClaim`), so no `when` is evaluated again: one that calls a registered function
// could see a working set the run changed, or change it.
function noDecisionMessage({ outputs, sections }, ws, claimedSection) {
  const unset = outputs.filter((output) => !isPresent(ws, output));
  const claimed = claimedSection === null ? -1 : sections.indexOf(claimedSection);
  const described = sections.map((section, index) => {
    if (claimed !== -1 && index > claimed) return `${section.name} (not reached)`;
    if (index < claimed || claimed === -1) return `${section.name} (when false)`;
    return `${section.name} (when true, ${section.rules.length ? 'no rule held' : 'nothing left to gather'})`;
  });
  return `decide: no section decided; unset outputs: ${unset.length > 0 ? unset.join(', ') : 'none'}; sections: ${described.join(', ')}`;
}
