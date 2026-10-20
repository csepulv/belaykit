import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const stateOf = (container, key) => (key in container ? 'present' : 'absent');

const registry = {
  producers: {},
  actions: { flag: { writes: ['flags', 'write'] } },
  functions: [
    { signature: 'app_state(map, string): string', handler: stateOf, keyArgs: { key: 1, in: 0 } },
    { signature: 'app_other(map, string): string', handler: stateOf },
  ],
  initialKeys: ['primary', 'item'],
  shapes: { write: { type: 'object', properties: { action: {}, pageId: {} }, additionalProperties: false } },
};

const rulebookWith = (when) => `
version: 1
sections:
  - name: route
    when: "true"
    rules:
      - when: '${when}'
        then: { action: flag }
`;

const errorsOf = (when) => {
  try {
    Rulebook.fromText(rulebookWith(when), registry);
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

describe('keys passed to helpers', () => {
  test('a misspelled literal key on ws is refused like ws.<key>', () => {
    expect(errorsOf('app_state(ws, "primry") == "absent"')).toEqual(['section "route" rule 1 when: unknown ws field "primry"']);
    expect(errorsOf('app_state(ws, "primary") == "absent"')).toEqual([]);
  });

  test('a misspelled literal key on ws.<key> is checked against its shape', () => {
    expect(errorsOf('app_state(ws.write, "acton") == "absent"')).toEqual(['section "route" rule 1 when: unknown field "acton" on ws.write']);
    expect(errorsOf('app_state(ws.write, "action") == "absent"')).toEqual([]);
  });

  test('a key that is not a literal is not checked', () => {
    expect(errorsOf('app_state(ws, ws.item) == "absent"')).toEqual([]);
  });

  test('a container that is not ws or ws.<key> is not checked', () => {
    expect(errorsOf('app_state({"a": 1}, "zzz") == "absent"')).toEqual([]);
  });

  test('a helper without keyArgs is not checked', () => {
    expect(errorsOf('app_other(ws, "zzz") == "absent"')).toEqual([]);
  });
});
