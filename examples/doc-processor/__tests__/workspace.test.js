import { expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '@belaykit/rulebook';

// The example runs against the workspace's packages, by name, as a consumer would.
test('the example resolves both BelayKit packages from the workspace', () => {
  expect(typeof Agent).toBe('function');
  expect(typeof Rulebook.fromText).toBe('function');
});
