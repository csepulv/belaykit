import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as core from '@belaykit/core';
import * as unscoped from 'belaykit';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

// `belaykit` is the core under its plain name: the same exports, the same objects, and the core
// as its one dependency. Its `version` is its own, so with the core's equal to it, this also
// holds the two packages to one version.
test('belaykit exports exactly what @belaykit/core exports, as the same objects', () => {
  expect(Object.keys(unscoped).sort()).toEqual(Object.keys(core).sort());
  for (const name of Object.keys(core)) expect(unscoped[name]).toBe(core[name]);
});

test('the exported version is the one in belaykit\'s package.json', () => {
  expect(unscoped.version).toBe(manifest.version);
});

test('its only dependency is @belaykit/core', () => {
  expect(Object.keys(manifest.dependencies)).toEqual(['@belaykit/core']);
  expect(manifest.peerDependencies).toBeUndefined();
});
