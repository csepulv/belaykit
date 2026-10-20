import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeFunctions } from '../reference.js';
import { triageRegistry } from './fixtures/registry.js';

const REFERENCE = `# Rulebook functions

Registry version: 3

## app_isBlank

\`app_isBlank(string): bool\`

True when the string is empty or whitespace.

| Parameter | Type | Description |
| --- | --- | --- |
| text | string | The string to test |

## app_state

\`app_state(map<dyn, dyn>, string): string\`

| Parameter | Type | Description |
| --- | --- | --- |
| arg0 | map<dyn, dyn> | |
| arg1 | string | |

Argument \`arg1\` names a field of argument \`arg0\`; a literal key is checked at load.
`;

describe('describeFunctions', () => {
  test('lists each registered function with its signature, description and parameters', () => {
    expect(describeFunctions(triageRegistry)).toBe(REFERENCE);
  });

  test('leaves out the version line when the registry has none, and CEL\'s own functions always', () => {
    const { version, ...unversioned } = triageRegistry;
    const reference = describeFunctions(unversioned);

    expect(reference).not.toMatch(/Registry version/);
    expect(reference).not.toMatch(/## (size|matches|contains)/);
  });

  test('an overload of a CEL built-in lists only the registry\'s own signature', () => {
    const registry = { producers: {}, actions: {}, functions: [{ signature: 'size(map, string): int', handler: () => 0n }] };

    expect(describeFunctions(registry)).toBe('# Rulebook functions\n\n## size\n\n`size(map<dyn, dyn>, string): int`\n\n'
      + '| Parameter | Type | Description |\n| --- | --- | --- |\n| arg0 | map<dyn, dyn> | |\n| arg1 | string | |\n');
  });

  test('table cells keep their table: pipes are escaped and newlines become spaces', () => {
    const registry = {
      producers: {},
      actions: {},
      functions: [{ signature: 'app_pick(string): bool', handler: () => true, params: [{ name: 'choice', description: 'a | b\nor c' }] }],
    };

    expect(describeFunctions(registry)).toContain('| choice | string | a \\| b or c |');
  });

  test('a registry with no functions says so', () => {
    expect(describeFunctions({ producers: {}, actions: {} })).toBe('# Rulebook functions\n\nNo functions are registered.\n');
  });

  test('a registry whose functions fail to register throws, listing them', () => {
    const broken = { ...triageRegistry, functions: [{ signature: 'app.matches(string): bool', handler: () => true }] };

    expect(() => describeFunctions(broken)).toThrow('function "app.matches": dots aren\'t allowed in names; use app_matches');
  });
});

describe('belaykit-rulebook reference', () => {
  test('prints the reference for the registry', () => {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const cwd = fileURLToPath(new URL('./fixtures/', import.meta.url));
    const { status, stdout } = spawnSync(process.execPath, [cli, 'reference', '--registry', 'registry.js#triageRegistry'], { cwd, encoding: 'utf-8' });

    expect(status).toBe(0);
    expect(stdout).toBe(REFERENCE);
  });
});
