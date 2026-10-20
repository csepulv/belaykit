import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The core is a peer: the plugin must load the agent's copy of the loop, never
// one of its own. In this workspace that copy is packages/core.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_ROOT = realpathSync(resolve(PACKAGE_ROOT, '..', 'core'));
const CORE_LINK = join(PACKAGE_ROOT, 'node_modules', '@belaykit', 'core');

test('@belaykit/core resolves from the plugin to packages/core', () => {
  const resolved = realpathSync(createRequire(join(PACKAGE_ROOT, 'index.js')).resolve('@belaykit/core'));

  expect(dirname(resolved)).toBe(CORE_ROOT);
});

test('the plugin links to the core rather than holding a copy', () => {
  expect(lstatSync(CORE_LINK).isSymbolicLink()).toBe(true);
});
