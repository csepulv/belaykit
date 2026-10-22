import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { version } from '@belaykit/core';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

// The version is a literal in the source, so the core imports nothing; this keeps it honest.
test('the exported version is the one in package.json', () => {
  expect(version).toBe(manifest.version);
});
