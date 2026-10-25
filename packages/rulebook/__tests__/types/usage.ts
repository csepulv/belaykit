// Type-check fixture for the plugin's .d.ts contract, compiled by `pnpm run check:types`
// under `bundler` and `nodenext` resolution. Never run. Each @ts-expect-error is a
// wrong usage the contract must reject; if one compiles, the check fails.
import { Agent, always, chain } from '@belaykit/core';
import { describeFunctions, loadFixture, Rulebook, schemaVersions, version } from '@belaykit/rulebook';
import type {
  ActionContext, Decision, Fixture, FixtureRun, JsonSchema, Producer, RegisteredAction, RegisteredFunction, Registry, Rule,
  RulebookTextOptions, Section, SelectedItem, WorkingSet,
} from '@belaykit/rulebook';

interface Deps {
  findRow: (item: string) => Promise<string | null>;
}

const findRow: Producer<Deps> = { writes: ['existing_row'], run: async (ws, deps) => deps.findRow(String(ws.item)) };
const writeParams: JsonSchema = { type: 'object', properties: { write: { enum: ['created', 'updated'] } }, required: ['write'] };
const finalize: RegisteredAction<Deps> = { writes: ['write'], params: writeParams, run: async (ws, { params }: ActionContext<Deps>) => { ws.write = params.write; } };
// @ts-expect-error a params schema is a JSON Schema (an object or a boolean), not a list of names
export const listedParams: RegisteredAction<Deps> = { params: ['write'], run: async () => {} };
const blank: RegisteredFunction = { signature: 'blank(string): bool', handler: (text: string) => text.length === 0 };

const registry: Registry<Deps> = {
  producers: { find_row: findRow },
  actions: { finalize },
  functions: [blank],
  initialKeys: ['item'],
  shapes: { existing_row: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } },
};

// @ts-expect-error `fields` is gone: the registry describes keys with `shapes`
export const oldFields: Registry<Deps> = { producers: {}, actions: {}, fields: { existing_row: ['id'] } };

const rulebook: Rulebook = Rulebook.fromText('version: 1\nsections: []\n', registry);
export const fromFile: Rulebook = Rulebook.load('triage.rules.yaml', registry);
const textOptions: RulebookTextOptions = { baseDir: 'rules' };
export const withImports: Rulebook = Rulebook.fromText('version: 1\nimports: [./common.macros.yaml]\nsections: []\n', registry, textOptions);
export const checkedWithImports: string[] = Rulebook.check('version: 1\nsections: []\n', registry, { baseDir: 'rules' });
export const rulebookReference: string = withImports.describeFunctions();
export const macroFileProblems: string[] = Rulebook.checkMacros('version: 1\nmacros: {}\n', registry, { baseDir: 'rules' });
// @ts-expect-error a macro file is checked against a registry
export const macroFileWithoutRegistry: string[] = Rulebook.checkMacros('version: 1\nmacros: {}\n');
// @ts-expect-error baseDir is a folder's path, a string
export const numericBaseDir: Rulebook = Rulebook.fromText('version: 1\nsections: []\n', registry, { baseDir: 3 });
// @ts-expect-error the text entry points take baseDir only
export const unknownTextOption: string[] = Rulebook.check('version: 1\nsections: []\n', registry, { basedir: 'rules' });

export const sections: readonly Section[] = rulebook.sections;
export const rules: Rule[] = rulebook.sections.flatMap((section) => section.rules);
export const ruleIds: string[] = rules.map((rule) => rule.id);
export const bindings: (string | null)[] = rules.map((rule) => rule.selectFirst?.name ?? null);
export const declaredKeys: readonly string[] = rulebook.declaredKeys;

type Subject = { item: string };
type State = Subject & WorkingSet;

const createProvider = async () => ({
  name: 'create',
  mode: 'first' as const,
  choices: [{ name: 'create', criteria: always, actions: [async (ws: State) => { ws.write = 'created'; }] }],
});

const agent = new Agent<Subject, State>({
  initializer: (subject) => rulebook.initialize(subject),
  choiceProvider: chain<State>([rulebook.provider({ findRow: async () => null }), createProvider]),
  finishChecker: (ws) => ws.write !== null,
});

// A rulebook's provider alone is the agent's provider; it may pass, and the run then fails.
export const alone = new Agent<Subject, State>({
  initializer: (subject) => rulebook.initialize(subject),
  choiceProvider: rulebook.provider(),
  finishChecker: (ws) => ws.write !== null,
});

export async function describeRun(): Promise<string> {
  const outcome = await agent.run({ item: 'x' });
  if (outcome.status === 'failed') return outcome.error.message;
  // @ts-expect-error a working set has no `gathered` since 0.2: a needs key is gathered when present
  const gathered: string[] = outcome.workingSet.gathered;
  return `${outcome.status}: ${'existing_row' in outcome.workingSet}, ${gathered}`;
}

// A guarded action: a rule may name it, but it runs only while its guard holds.
export const guarded: RegisteredAction<Deps> = { writes: ['write'], guard: 'has(ws.existing_row)', run: async (ws) => { ws.write = 'updated'; } };
// @ts-expect-error a guard is one CEL expression, not a list
export const guardList: RegisteredAction<Deps> = { guard: ['has(ws.existing_row)'], run: async () => {} };

// An action that has a key gathered again.
export const recheck: RegisteredAction<Deps> = { run: async (ws) => rulebook.regather(ws, 'existing_row') };

// A decision: the outputs once completed, a reason otherwise.
export async function describeDecision(): Promise<string> {
  const decision: Decision = await rulebook.decide({ item: 'x' }, { deps: { findRow: async () => null }, maxIterations: 10 });
  if (decision.status === 'completed') return JSON.stringify(decision.outputs);
  // @ts-expect-error only a completed decision has outputs
  const outputs = decision.outputs;
  return `${decision.status}: ${decision.error} ${outputs}`;
}

// @ts-expect-error decide takes deps and maxIterations, not a tracer
export const decidedWithTracer = rulebook.decide({}, { tracer: false });

// @ts-expect-error a rulebook is made by load or fromText
export const constructed = new Rulebook();

export const producerWithoutRun: Registry = {
  // @ts-expect-error a producer must have `run`
  producers: { find_row: { writes: ['existing_row'] } },
  actions: {},
};

export const documentedRegistry: Registry<Deps> = {
  ...registry,
  version: '3',
  functions: [
    {
      signature: 'app_state(map, string): string',
      handler: (container: Record<string, unknown>, key: string) => (key in container ? 'present' : 'absent'),
      description: 'Whether a key is present.',
      params: [{ name: 'container' }, { name: 'key', description: 'The field to look for' }],
      keyArgs: { key: 1, in: 0 },
    },
  ],
};

export const problems: string[] = Rulebook.check('version: 1\nsections: []\n', documentedRegistry);
export const reference: string = describeFunctions(documentedRegistry);

const fixture: Fixture = {
  initial: { item: 'x' },
  produce: { existing_row: 'row-1' },
  expect: { status: 'completed', fired: ['gather existing_row', 'judge#1'] },
};

export const loadedFixture: Fixture = loadFixture('triage-fixture.yaml');

export async function describeFixtureRun(): Promise<string> {
  const run: FixtureRun = await rulebook.runFixture({
    fixture,
    deps: { findRow: async () => null },
    finishChecker: (ws) => ws.write !== null,
    maxIterations: 5,
  });
  const fired: string[] = run.trace.flatMap((entry) => entry.fired);
  return `${run.status} ${fired.join(',')} ${run.mismatches.join('; ')}`;
}

export const keyArgsByName: Registry = {
  producers: {},
  actions: {},
  // @ts-expect-error keyArgs are argument indexes, not names
  functions: [{ signature: 'app_state(map, string): string', handler: () => 'absent', keyArgs: { key: 'key', in: 'container' } }],
};

export const unknownStatus: Fixture = {
  initial: {},
  // @ts-expect-error status is one of the run outcomes
  expect: { status: 'done' },
};

export async function fixtureWithoutFinishChecker() {
  // @ts-expect-error a fixture run needs the agent's finishChecker
  return rulebook.runFixture({ fixture });
}

export async function fixtureWithOldOption() {
  // @ts-expect-error runFixture takes finishChecker, not isFinished
  return rulebook.runFixture({ fixture, finishChecker: () => true, isFinished: () => true });
}

// Selection, the action context, and fixtures with a result and an error.
export const nodeRegistry: Registry<Deps> = {
  producers: {},
  actions: {
    probe: {
      writes: ['nodes'],
      run: async (ws, { selected, deps }) => {
        if (!selected) return;
        const item: SelectedItem = selected;
        const index: number = item.index;
        const row = await deps.findRow(item.name);
        ws.nodes = (ws.nodes as unknown[]).map((node, position) => (position === index ? { node, row } : node));
      },
    },
  },
  initialKeys: ['nodes', 'status'],
};

export const outcomeFixture: Fixture = {
  initial: { nodes: [], status: null },
  expect: { status: 'failed', error: 'selectFirst evaluated to string', result: { outcome: 'hold' } },
};

export async function readFixtureOutcome(): Promise<string> {
  const run = await Rulebook.fromText('version: 1\nsections: []\n', nodeRegistry).runFixture({
    fixture: outcomeFixture,
    finishChecker: (ws) => ws.status !== null,
    finalizer: (ws) => ({ outcome: ws.status }),
  });
  return `${run.status} ${String(run.result)} ${run.error ?? ''}`;
}

export const selectedIndexIsNumber: Registry = {
  producers: {},
  actions: {
    // @ts-expect-error the selected item's index is a number
    probe: { run: async (ws, { selected }) => { const index: string | undefined = selected?.index; } },
  },
};

export const errorIsText: Fixture = {
  initial: {},
  // @ts-expect-error an expected error is a substring of the message
  expect: { status: 'failed', error: 42 },
};

export const rulebookVersion: string = version;
export const readableVersions: readonly number[] = schemaVersions;
// @ts-expect-error schemaVersions is read-only
schemaVersions.push(2);

// @ts-expect-error the old functions (loadStageFile, yamlProvider, …) are gone; Rulebook replaces them
export { loadStageFile, yamlProvider } from '@belaykit/rulebook';
