import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: {},
  actions: { flag: { writes: ['flags'] } },
  initialKeys: ['text', 'pattern'],
};

const rulebookWith = (when) => `
version: 1
sections:
  - name: scan
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

describe('patterns passed to matches', () => {
  test('a literal pattern that does not compile is refused at load', () => {
    expect(errorsOf('ws.text.matches("(")')).toEqual(['section "scan" rule 1 when: pattern "(" is not a valid regular expression']);
  });

  test('a literal pattern that may backtrack exponentially is refused at load', () => {
    expect(errorsOf('ws.text.matches("(a+)+$")')).toEqual(['section "scan" rule 1 when: pattern "(a+)+$" may backtrack exponentially']);
  });

  test('a pattern that is not a literal is refused at load', () => {
    expect(errorsOf('ws.text.matches(ws.pattern)')).toEqual(['section "scan" rule 1 when: pattern must be a string literal']);
  });

  test('a safe literal pattern loads and evaluates', async () => {
    const rulebook = Rulebook.fromText(rulebookWith('ws.text.matches("^[a-z]+$")'), registry);
    const choiceSet = await rulebook.provider()(rulebook.initialize({ text: 'abc', pattern: null }));

    expect(await choiceSet.choices[0].criteria({ text: 'abc' })).toEqual({ matched: true });
    expect(await choiceSet.choices[0].criteria({ text: 'ABC' })).toEqual({ matched: false });
  });
});
