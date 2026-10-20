// A rulebook: a YAML + CEL file of sections and rules, checked at load against the
// agent's registry, which it keeps. It provides the agent's choices, the working set's
// starting keys, re-gathering, and fixture runs. Its CEL environment stays inside it.
import { runFixture } from './fixture.js';
import { checkRulebook, loadRulebook, loadRulebookText } from './load.js';
import { initialWorkingSet, rulebookProvider } from './provider.js';

// Only `load` and `fromText` make a rulebook, so every one has passed the checks.
const CHECKED = Symbol('checked rulebook');

const FIXTURE_OPTIONS = ['fixture', 'deps', 'finishChecker', 'finalizer', 'maxIterations'];

export class Rulebook {
  #loaded;
  #registry;

  constructor(checked, loaded, registry) {
    if (checked !== CHECKED) throw new TypeError('new Rulebook: use Rulebook.load(path, registry) or Rulebook.fromText(text, registry)');
    this.#loaded = loaded;
    this.#registry = keptRegistry(registry);
  }

  static load(path, registry) {
    requireString('Rulebook.load', 'path', path);
    return new Rulebook(CHECKED, loadRulebook(path, registry), registry);
  }

  static fromText(text, registry) {
    requireString('Rulebook.fromText', 'text', text);
    return new Rulebook(CHECKED, loadRulebookText(text, registry), registry);
  }

  static check(text, registry) {
    requireString('Rulebook.check', 'text', text);
    return checkRulebook(text, registry);
  }

  // Copies, so a caller can't change what the rulebook runs.
  get sections() {
    return this.#loaded.sections.map(describeSection);
  }

  get declaredKeys() {
    return [...this.#loaded.declaredKeys];
  }

  initialize(initial) {
    return initialWorkingSet(this.#loaded, initial);
  }

  provider(deps) {
    return rulebookProvider(this.#loaded, this.#registry, deps);
  }

  // Under the presence model a key is gathered once; this has its section gather it again.
  regather(workingSet, key) {
    const { declaredKeys } = this.#loaded;
    if (!declaredKeys.includes(key)) {
      throw new TypeError(`regather: "${key}" is not a needs key of this rulebook (needs keys: ${declaredKeys.join(', ')})`);
    }
    workingSet[key] = null;
    workingSet.gathered = workingSet.gathered.filter((gathered) => gathered !== key);
  }

  async runFixture(options = {}) {
    const unknown = Object.keys(options ?? {}).find((key) => !FIXTURE_OPTIONS.includes(key));
    if (unknown !== undefined) {
      throw new TypeError(`rulebook.runFixture: unknown option "${unknown}" (options: ${FIXTURE_OPTIONS.join(', ')})`);
    }
    for (const required of ['fixture', 'finishChecker']) {
      if (!options?.[required]) throw new TypeError(`rulebook.runFixture: "${required}" is required`);
    }
    return runFixture({ ...options, loaded: this.#loaded, registry: this.#registry });
  }
}

// Without this, a missing or non-string argument fails deep in the parser with a native message.
function requireString(caller, argument, value) {
  if (typeof value !== 'string') throw new TypeError(`${caller}: ${argument} must be a string`);
}

// The registry as checked: its producers and actions are copied, so changing the caller's
// registry later can't change what this rulebook runs.
const keptRegistry = (registry) => ({
  ...registry,
  producers: copyEach(registry.producers),
  actions: copyEach(registry.actions),
});

// `run` is kept bound to its entry, so an entry made from a class keeps its method.
const copyEach = (entries) => Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, {
  ...entry,
  run: typeof entry.run === 'function' ? entry.run.bind(entry) : entry.run,
}]));

const describeSection = ({ name, when, needs, hitPolicy, rules }) => ({
  name, when, needs: { ...needs }, hitPolicy, rules: rules.map(describeRule),
});

const describeRule = ({ id, selectFirst, when, action, params, why }) => ({
  id,
  selectFirst: selectFirst && { name: selectFirst.name, expression: selectFirst.expression },
  when,
  action,
  params: structuredClone(params),
  why,
});
