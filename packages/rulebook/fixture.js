// Fixture runs: a rulebook run on the core against a text fixture, with no model calls
// and no writes the caller didn't fake. Producers are replaced by the fixture's `produce`
// values; actions are the registry's own, given the caller's `deps`.
import { readFileSync } from 'node:fs';
import { inspect, isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { Agent } from '@belaykit/core';
import { YAMLError, parse as parseYaml } from 'yaml';
import { schemaMessage } from './schema-message.js';
import { initialWorkingSet, rulebookProvider } from './provider.js';

const validateFixture = new Ajv({ allErrors: true }).compile({
  type: 'object',
  required: ['initial', 'expect'],
  additionalProperties: false,
  properties: {
    initial: { type: 'object' },
    produce: { type: 'object' },
    expect: {
      type: 'object',
      required: ['status'],
      additionalProperties: false,
      properties: {
        status: { enum: ['completed', 'no_match', 'failed'] },
        fired: { type: 'array', items: { type: 'string' } },
        result: {},
        error: { type: 'string' },
      },
    },
  },
});

export function loadFixture(path) {
  const fixture = parseFixtureYaml(path, readFileSync(path, 'utf-8'));
  if (!validateFixture(fixture)) throw new Error(validateFixture.errors.map((error) => `${path}: ${schemaMessage(error)}`).join('\n'));
  return fixture;
}

// As for a rulebook (load.js): the yaml package throws a YAMLError for bad syntax and a
// ReferenceError for a bad alias; either is a problem in this file, so it names the file.
function parseFixtureYaml(path, text) {
  try {
    return parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLError || error instanceof ReferenceError) throw new Error(`${path}: YAML: ${error.message.split('\n')[0]}`, { cause: error });
    throw error;
  }
}

// The run uses the default trace, whatever the agent's own hook, because `fired` is
// compared against it.
export async function runFixture({ loaded, registry, fixture, deps, finishChecker, finalizer, maxIterations }) {
  const missingKeys = new Set();
  const fixtureRun = withFixtureProducers(loaded, registry, fixture.produce ?? {}, missingKeys);
  const outcome = await new Agent({
    initializer: () => initialWorkingSet(fixtureRun.loaded, structuredClone(fixture.initial)),
    choiceProvider: rulebookProvider(fixtureRun.loaded, fixtureRun.registry, deps),
    finishChecker,
    ...(finalizer && { finalizer }),
  }, { maxIterations }).run();
  const { status, trace, workingSet } = outcome;
  return {
    status,
    ...('result' in outcome && { result: outcome.result }),
    ...(outcome.error && { error: outcome.error.message }),
    trace,
    workingSet,
    mismatches: mismatchesOf(outcome, fixture.expect, missingKeys),
  };
}

// Each `needs` key gets its own producer, so a value goes to the key it was written for,
// even when one registry producer serves several keys. A key the run asks for and the
// fixture lacks is recorded, so a fixture that expects `failed` can't pass because of it.
function withFixtureProducers(loaded, registry, produce, missingKeys) {
  const producerFor = (key) => `fixture ${key}`;
  const sections = loaded.sections.map((section) => ({
    ...section,
    needs: Object.fromEntries(Object.keys(section.needs).map((key) => [key, producerFor(key)])),
  }));
  const producers = Object.fromEntries(loaded.declaredKeys.map((key) => [producerFor(key), {
    run: async () => {
      if (!Object.hasOwn(produce, key)) {
        missingKeys.add(key);
        throw new Error(`fixture has no produce value for "${key}"`);
      }
      return structuredClone(produce[key]);
    },
  }]));
  return { loaded: { ...loaded, sections }, registry: { ...registry, producers } };
}

// Printable, because JSON.stringify escapes control characters.
const BIGINT_MARK = '__belaykit_bigint__:';

// A result as text, for a mismatch. CEL integers are BigInts (2n), which JSON can't
// write, and an agent's result may be circular; neither may make a fixture run throw.
function describe(value) {
  try {
    return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${BIGINT_MARK}${item}n` : item))
      .replace(new RegExp(`"${BIGINT_MARK}(-?\\d+n)"`, 'g'), '$1');
  } catch {
    return inspect(value, { depth: 4 });
  }
}

function mismatchesOf(outcome, expected, missingKeys) {
  const { status, error, trace } = outcome;
  const mismatches = [];
  if (status !== expected.status) {
    mismatches.push(`status: expected "${expected.status}", got "${status}"${error ? ` (${error.message})` : ''}`);
  }
  const fired = trace.flatMap((entry) => entry.fired);
  if (expected.fired && JSON.stringify(fired) !== JSON.stringify(expected.fired)) {
    mismatches.push(`fired: expected ${JSON.stringify(expected.fired)}, got ${JSON.stringify(fired)}`);
  }
  if ('result' in expected && !('result' in outcome && isDeepStrictEqual(outcome.result, expected.result))) {
    const got = 'result' in outcome ? describe(outcome.result) : 'none';
    mismatches.push(`result: expected ${describe(expected.result)}, got ${got}`);
  }
  if (expected.error !== undefined && !error?.message.includes(expected.error)) {
    mismatches.push(`error: expected a message containing "${expected.error}", got ${error ? `"${error.message}"` : 'none'}`);
  }
  for (const key of missingKeys) mismatches.push(`produce: no value for "${key}", which the run needed`);
  return mismatches;
}
