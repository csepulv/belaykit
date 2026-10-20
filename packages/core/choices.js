// Small building blocks for choices and providers.

// A criterion that matches any working set — for unconditional steps and fallbacks.
export const always = async () => ({ matched: true });

// Compose providers: the first one that returns a choice set claims the
// iteration, so a rulebook can hand gaps to a code provider. A chain is a provider
// like any other: when none of its providers claims the working set, it passes too.
export function chain(providers) {
  return async (workingSet) => {
    for (const provider of providers) {
      const choiceSet = await provider(workingSet);
      if (choiceSet) return choiceSet;
    }
    return null;
  };
}
