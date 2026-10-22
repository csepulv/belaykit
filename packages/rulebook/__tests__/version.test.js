import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Rulebook, schemaVersions, version } from '@belaykit/rulebook';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));
const registry = { producers: {}, actions: { done: { run: async () => {} } } };
const rulebookOfVersion = (schemaVersion) => `version: ${schemaVersion}
sections:
  - name: only
    when: "true"
    rules:
      - when: "true"
        then: { action: done }
`;

test('the exported version is the one in package.json', () => {
  expect(version).toBe(readJson('../package.json').version);
});

test('schemaVersions lists exactly the rulebook versions the schema accepts', () => {
  expect(schemaVersions).toEqual([readJson('../schema.json').properties.version.const]);
  for (const schemaVersion of schemaVersions) expect(Rulebook.check(rulebookOfVersion(schemaVersion), registry)).toEqual([]);
  expect(Rulebook.check(rulebookOfVersion(Math.max(...schemaVersions) + 1), registry)).toEqual(['version: must be 1']);
});

// The packages are released together, at one version, and the rulebook takes that core as its peer.
test('the rulebook\'s version and peer range follow the core\'s version', () => {
  const core = readJson('../../core/package.json');
  const rulebook = readJson('../package.json');
  expect(rulebook.version).toBe(core.version);
  expect(rulebook.peerDependencies['@belaykit/core']).toBe(`^${core.version}`);
});
