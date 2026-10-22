import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeFunctions } from '../reference.js';
import { triageRegistry } from './fixtures/registry.js';

// BelayKit's own helpers come first in every reference, whatever the registry holds.
const HELPERS = `Functions named \`belaykit.*\` are BelayKit's own helpers, in every rulebook; the others are the registry's.

## belaykit.present

\`belaykit.present(dyn, dyn): bool\`

True when every key on the path exists and the last value isn't null. A missing key, or a null on the way, is false; a step into a value that isn't a map, and an empty path or segment, are errors. \`has()\` is true for a key holding null.

| Parameter | Type | Description |
| --- | --- | --- |
| container | dyn | A map to read from: ws, a selectFirst binding or a macro variable |
| path | dyn | Keys joined by dots, such as "facts.recurrence": a string literal, checked at load like the fields it reads |`;

const REFERENCE = `# Rulebook functions

Registry version: 3

${HELPERS}

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

    expect(describeFunctions(registry)).toBe(`# Rulebook functions\n\n${HELPERS}\n\n## size\n\n\`size(map<dyn, dyn>, string): int\`\n\n`
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

  test('a registry with no functions lists the helpers, and says it has none of its own', () => {
    expect(describeFunctions({ producers: {}, actions: {} })).toBe(`# Rulebook functions\n\n${HELPERS}\n\nThe registry has no functions of its own.\n`);
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
