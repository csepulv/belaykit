// BelayKit's agent loop: the finish checker is called before each provider call, zero
// matches ends the run as `no_match`, and actions mutate the working set. Best effort: a run
// never rejects — an error ends it as `failed`, with its source named and the
// trace so far. The trace is returned beside the working set, not in it; the agent's
// tracer decides what it keeps, and its finalizer what the run returns.

export class IterationLimitError extends Error {
  constructor(maxIterations, trace) {
    super(`agent stopped after ${maxIterations} iterations without finishing`);
    this.name = 'IterationLimitError';
    this.trace = trace;
  }
}

const ESSENTIALS = ['initializer', 'choiceProvider', 'finishChecker', 'finalizer'];
const OPTIONS = ['tracer', 'maxIterations'];

// Configured once, run per subject. The essentials make the agent this agent; the
// options are its incidentals.
export class Agent {
  #essentials;
  #options;

  constructor(essentials, options = {}) {
    options ??= {};
    if (!isPlainObject(essentials)) throw new TypeError('new Agent: the essentials must be an object');
    if (!isPlainObject(options)) throw new TypeError('new Agent: the options must be an object');
    refuseUnknownKeys(essentials, { kind: 'essential', known: ESSENTIALS, other: { kind: 'option', known: OPTIONS, argument: 'second' } });
    refuseUnknownKeys(options, { kind: 'option', known: OPTIONS, other: { kind: 'essential', known: ESSENTIALS, argument: 'first' } });
    const { initializer, choiceProvider, finishChecker, finalizer = (workingSet) => workingSet } = essentials;
    const { tracer = (entry) => entry, maxIterations = 25 } = options;
    refuseMalformedParts({ initializer, choiceProvider, finishChecker, finalizer, tracer, maxIterations });
    this.#essentials = { initializer, choiceProvider, finishChecker, finalizer };
    this.#options = { tracer, maxIterations };
  }

  run(subject) {
    return runLoop(subject, { ...this.#essentials, ...this.#options });
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// In plain JavaScript a misplaced key (an option among the essentials, or a name from an
// older API) would otherwise be ignored without a word, and the agent would run on defaults.
function refuseUnknownKeys(given, { kind, known, other }) {
  const unknown = Object.keys(given).find((key) => !known.includes(key));
  if (unknown === undefined) return;
  const hint = other.known.includes(unknown)
    ? `it is an ${other.kind}: pass it in the ${other.argument} argument`
    : `${kind}s: ${known.join(', ')}`;
  throw new TypeError(`new Agent: unknown ${kind} "${unknown}" (${hint})`);
}

// A missing or mistyped part would otherwise fail every run, far from where it was set.
function refuseMalformedParts({ tracer, maxIterations, ...functions }) {
  const notFunction = Object.keys(functions).find((name) => typeof functions[name] !== 'function');
  if (notFunction) throw new TypeError(`new Agent: ${notFunction} must be a function`);
  if (tracer !== false && typeof tracer !== 'function') throw new TypeError('new Agent: tracer must be a function or false');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new TypeError(`new Agent: maxIterations must be a positive integer, got ${describeValue(maxIterations)}`);
  }
}

// A run that ends normally (`completed`, `no_match`) returns the agent's result beside
// the working set; a failed one doesn't, since its working set may be half-updated.
async function runLoop(subject, { initializer, finalizer, ...loop }) {
  const trace = [];
  let workingSet = null;
  try {
    workingSet = await withContext('initializer', () => initializer(subject));
    const { status } = await iterate(workingSet, loop, trace);
    return { status, result: await withContext('finalizer', () => finalizer(workingSet)), workingSet, trace };
  } catch (error) {
    return { status: 'failed', error: withTrace(error, trace), workingSet, trace };
  }
}

// Each iteration starts its entry before the provider is called and fills it in as it
// runs; as the iteration ends, the agent's tracer decides what to keep of it. An
// iteration that fails is kept too, as a partial entry marked `failed`.
async function iterate(workingSet, { choiceProvider, finishChecker, tracer, maxIterations }, trace) {
  const finished = () => withContext('finishChecker', () => finishChecker(workingSet));

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (await finished()) return { status: 'completed' };

    const record = { entry: startEntry(iteration), matches: [] };
    const started = performance.now();
    let selected;
    try {
      selected = await runIteration(choiceProvider, workingSet, record);
    } catch (error) {
      record.entry.failed = true;
      record.durationMs = elapsedSince(started);
      await keepFailedIteration(record, tracer, trace);
      throw error;
    }
    record.durationMs = elapsedSince(started);
    await keepIteration(record, tracer, trace);
    if (selected.length === 0) return { status: 'no_match' };
  }
  if (await finished()) return { status: 'completed' };
  throw new IterationLimitError(maxIterations, trace);
}

const elapsedSince = (started) => Math.round(performance.now() - started);

// The tracer sees the default entry and, beside it, every criterion result of the iteration
// (`data` included) and its duration, and returns what to keep, or null to keep nothing.
// The entry holds only what the run decided, so the default trace is the same on every run;
// what is measured stays beside it. `tracer: false` keeps nothing.
async function keepIteration({ entry, matches, durationMs }, tracer, trace) {
  if (tracer === false) return;
  const kept = await withContext('tracer', () => tracer(entry, { matches, durationMs }));
  if (kept !== null && kept !== undefined) trace.push(kept);
}

// On an iteration that already failed, a tracer that throws can't replace the run's error,
// so the entry is kept as the Decider built it.
async function keepFailedIteration(record, tracer, trace) {
  try {
    await keepIteration(record, tracer, trace);
  } catch {
    trace.push(record.entry);
  }
}

const startEntry = (iteration) => ({
  iteration, set: `set ${iteration}`, fired: [], evaluated: [], unevaluated: [], executed: [],
});

async function runIteration(choiceProvider, workingSet, record) {
  const { entry } = record;
  const choiceSet = await nextChoiceSet(choiceProvider, workingSet, entry.iteration);
  entry.set = choiceSet.name ?? entry.set;
  if (choiceSet.mode !== undefined) entry.mode = choiceSet.mode;
  let selected;
  try {
    selected = await selectChoices(choiceSet, entry.set, workingSet, record);
  } finally {
    entry.unevaluated = unevaluatedNames(choiceSet, entry);
  }
  await executeChoices(entry.set, selected, workingSet, entry);
  return selected;
}

// Choices whose criteria never ran: after a `first` match, a skipped fallback, or a failure.
// Each name once. With an unknown mode the groups are unknown, so the list is empty.
function unevaluatedNames(choiceSet, entry) {
  const mode = MODES[choiceSet.mode];
  if (!mode) return [];
  const evaluated = new Set(entry.evaluated.map(({ choice }) => choice));
  const names = mode.groups
    .flatMap((group) => (Array.isArray(choiceSet[group]) ? choiceSet[group] : []))
    .flatMap((choice) => (typeof choice?.name === 'string' ? [choice.name] : []))
    .filter((name) => !evaluated.has(name));
  return [...new Set(names)];
}

async function nextChoiceSet(choiceProvider, workingSet, iteration) {
  const source = `iteration ${iteration} choiceProvider`;
  const choiceSet = await withContext(source, () => choiceProvider(workingSet));
  if (!choiceSet || typeof choiceSet !== 'object') throw new Error(`${source} returned no choice set`);
  return choiceSet;
}

// Every mode selects before any action runs, so every choice in an iteration
// sees the same working set.
const MODES = {
  first: { groups: ['choices'], select: (set, label, ws, record) => matchChoices(label, set.choices, ws, record, { stopAtFirst: true }) },
  all: { groups: ['choices'], select: (set, label, ws, record) => matchChoices(label, set.choices, ws, record, { stopAtFirst: false }) },
  first_else_all: {
    groups: ['first', 'all'],
    select: async (set, label, ws, record) => {
      const first = await matchChoices(label, set.first, ws, record, { stopAtFirst: true });
      return first.length > 0 ? first : matchChoices(label, set.all, ws, record, { stopAtFirst: false });
    },
  },
  first_then_all: {
    groups: ['first', 'all'],
    select: async (set, label, ws, record) => [
      ...await matchChoices(label, set.first, ws, record, { stopAtFirst: true }),
      ...await matchChoices(label, set.all, ws, record, { stopAtFirst: false }),
    ],
  },
};

function selectChoices(choiceSet, label, workingSet, record) {
  const mode = MODES[choiceSet.mode];
  if (!mode) throw new Error(`choice set "${label}" has unknown mode "${choiceSet.mode}"`);
  const missing = mode.groups.find((group) => !Array.isArray(choiceSet[group]));
  if (missing) throw new Error(`choice set "${label}" (${choiceSet.mode}) needs an array "${missing}"`);
  for (const group of mode.groups) refuseMalformedChoices(label, group, choiceSet[group]);
  const duplicate = findDuplicateName(mode.groups.flatMap((group) => choiceSet[group]));
  if (duplicate !== null) throw new Error(`choice set "${label}" has duplicate choice name "${duplicate}"`);
  return mode.select(choiceSet, label, workingSet, record);
}

// Each choice is checked before any criterion runs, so a malformed one fails the run naming
// its place, rather than as a native error from deep in the loop.
function refuseMalformedChoices(label, group, choices) {
  choices.forEach((choice, index) => {
    const place = `choice set "${label}": choice ${index + 1} in "${group}"`;
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) throw new Error(`${place} is not a choice (${describeValue(choice)})`);
    if (typeof choice.name !== 'string') throw new Error(`${place} needs a string "name"`);
    if (typeof choice.criteria !== 'function') throw new Error(`choice set "${label}": choice "${choice.name}" needs a function "criteria"`);
  });
}

// Names are the trace's only identity, so they must be unique across every group. (Every
// choice has a string name by now: refuseMalformedChoices runs first.)
function findDuplicateName(choices) {
  const names = choices.map(({ name }) => name);
  const index = names.findIndex((name, position) => names.indexOf(name) !== position);
  return index === -1 ? null : names[index];
}

async function matchChoices(label, choices, workingSet, record, { stopAtFirst }) {
  const selected = [];
  for (const choice of choices) {
    const match = await evaluateCriteria(label, choice, workingSet, record);
    if (!match.matched) continue;
    selected.push({ choice, match });
    if (stopAtFirst) break;
  }
  return selected;
}

// Records every criterion that ran in `entry.evaluated`, including one that throws
// or returns something other than `{ matched: boolean }`, and every valid result, in
// full, in `matches` for the tracer.
async function evaluateCriteria(label, choice, workingSet, { entry, matches }) {
  const record = (result) => entry.evaluated.push({ choice: choice.name, ...result, ...(choice.why !== undefined && { why: choice.why }) });
  let match;
  try {
    match = await withContext(`${label}/${choice.name} criteria`, () => choice.criteria(workingSet));
  } catch (error) {
    record({ error: messageOf(error.cause) });
    throw error;
  }
  if (typeof match?.matched !== 'boolean') {
    const problem = `returned ${describeResult(match)}, expected { matched }`;
    record({ error: problem });
    throw new Error(`${label}/${choice.name} criteria ${problem}`);
  }
  // `detail` is the criterion's note for the trace; `data` is for its actions only.
  record({ matched: match.matched, ...(match.detail !== undefined && { detail: match.detail }) });
  matches.push({ choice: choice.name, result: match });
  return match;
}

async function executeChoices(label, selected, workingSet, entry) {
  for (const { choice, match } of selected) {
    if (!Array.isArray(choice.actions)) throw new Error(`${label}/${choice.name} needs an array "actions"`);
    for (const [index, action] of choice.actions.entries()) {
      await withContext(`${label}/${choice.name} action`, () => action(workingSet, match));
      entry.executed.push({ choice: choice.name, action: index });
    }
    entry.fired.push(choice.name);
  }
}

async function withContext(label, fn) {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${label} failed: ${messageOf(error)}`, { cause: error });
  }
}

// Total: a thrown value with no readable message (a null-prototype object, a throwing
// getter) still becomes text, so the run's error keeps naming its source.
function messageOf(error) {
  try {
    return error?.message ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

// A bad criterion result, described by its shape: `matched` as given, other keys by name,
// so `data` (large, private, or not serializable) never reaches a message or the trace.
function describeResult(match) {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) return describeValue(match);
  const fields = Object.keys(match).map((key) => (key === 'matched' ? `matched: ${describeValue(match.matched)}` : key));
  return `{ ${fields.join(', ')} }`;
}

const describeValue = (value) => {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return String(value); // JSON writes NaN and Infinity as null
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return JSON.stringify(value);
};

const withTrace = (error, trace) => Object.assign(error, { trace: error.trace ?? trace });
