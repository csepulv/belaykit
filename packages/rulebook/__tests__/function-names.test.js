import { describe, expect, test } from 'vitest';
import { loadRulebookText } from '../load.js';

const isBlank = (text) => !text.trim();

const registryWith = (functions) => ({
  producers: {},
  actions: { flag: { writes: ['flags'] } },
  functions,
  initialKeys: ['item'],
});

const rulebookWith = (when) => `
version: 1
sections:
  - name: check
    when: "true"
    rules:
      - when: '${when}'
        then: { action: flag }
`;

const errorsOf = (functions, when = 'true') => {
  try {
    loadRulebookText(rulebookWith(when), registryWith(functions));
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

describe('registered function names', () => {
  test('lower snake case and camelCase names both register', () => {
    const functions = [
      { signature: 'app_isBlank(string): bool', handler: isBlank },
      { signature: 'app_is_blank(string): bool', handler: isBlank },
    ];

    expect(errorsOf(functions, 'app_isBlank(ws.item) || app_is_blank(ws.item)')).toEqual([]);
  });

  test('a name outside the pattern is refused once, as a registry error', () => {
    expect(errorsOf([{ signature: 'Blank(string): bool', handler: isBlank }])).toEqual([
      'function "Blank": names must match ^[a-z][a-zA-Z0-9_]*$ (lower snake case or camelCase)',
    ]);
  });

  test('a dotted name is refused with the underscore form', () => {
    expect(errorsOf([{ signature: 'app.matches(string): bool', handler: () => true }])).toEqual([
      'function "app.matches": dots aren\'t allowed in names; use app_matches',
    ]);
  });

  test('a method on a CEL type is not a dotted name', () => {
    const functions = [{ signature: 'string.app_isBlank(): bool', handler: isBlank }];

    expect(errorsOf(functions, 'ws.item.app_isBlank()')).toEqual([]);
  });

  test('descriptions and parameter names reach the CEL environment', () => {
    const functions = [{
      signature: 'app_isBlank(string): bool',
      handler: isBlank,
      description: 'True when the string is empty or whitespace.',
      params: [{ name: 'text', description: 'The string to test' }],
      keyArgs: undefined,
    }];
    const { env } = loadRulebookText(rulebookWith('true'), registryWith(functions));
    const [definition] = env.getDefinitions().functions.filter((candidate) => candidate.name === 'app_isBlank');

    expect(definition.description).toBe('True when the string is empty or whitespace.');
    expect(definition.params).toEqual([{ name: 'text', type: 'string', description: 'The string to test' }]);
  });

  test('a function with keyArgs registers and can be called', () => {
    const functions = [{ signature: 'app_state(map, string): string', handler: () => 'absent', keyArgs: { key: 1, in: 0 } }];

    expect(errorsOf(functions, 'app_state(ws, "item") == "absent"')).toEqual([]);
  });

  test('keyArgs on a method is refused, since only global calls are checked', () => {
    const functions = [{ signature: 'map.app_has(string): bool', handler: () => true, keyArgs: { key: 0, in: 0 } }];

    expect(errorsOf(functions)).toEqual(['function "map.app_has": keyArgs applies to global functions, not methods']);
  });
});
