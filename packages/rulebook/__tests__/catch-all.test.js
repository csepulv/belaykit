// Since 0.2: a FIRST section with rules says what happens when none of them holds. Either its
// last rule always holds (`when: "true"`, without selectFirst), or it says `exhaustive: false`: no
// match is meant to end the run.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: { classify: { writes: ['label'], run: async () => 'x' } },
  actions: { settle: { writes: ['routing'], run: async () => {} } },
  initialKeys: ['items', 'routing'],
};

const withSection = (section) => `
version: 1
sections:
${section}`;

const FIX = 'a FIRST section must end in a rule with when: "true" (without selectFirst), or say exhaustive: false';

describe('the catch-all rule', () => {
  test.each([
    ['ends in a narrower rule', '  - name: decide\n    when: "true"\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n'],
    ['ends in a selectFirst rule that is always true', '  - name: decide\n    when: "true"\n    rules:\n      - selectFirst: { item: ws.items }\n        when: "true"\n        then: { action: settle }\n'],
    ['ends in a rule that is true but not the literal', '  - name: decide\n    when: "true"\n    rules:\n      - when: 1 == 1\n        then: { action: settle }\n'],
    ['has its catch-all before another rule', '  - name: decide\n    when: "true"\n    rules:\n      - when: "true"\n        then: { action: settle }\n      - when: ws.routing == null\n        then: { action: settle }\n'],
  ])('a FIRST section that %s is refused, naming both fixes', (_label, section) => {
    expect(Rulebook.check(withSection(section), registry)).toEqual([`section "decide": ${FIX}`]);
  });

  // The hit policy as the section resolves it, its own or the rulebook's default.
  test.each([
    ['FIRST by an explicit default', 'hitPolicyDefault: FIRST\n', ''],
    ['FIRST by its own hitPolicy, under an ALL default', 'hitPolicyDefault: ALL\n', '    hitPolicy: FIRST\n'],
  ])('a section that is %s is checked', (_label, top, own) => {
    const text = `version: 1\n${top}sections:\n  - name: decide\n    when: "true"\n${own}    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n`;
    expect(Rulebook.check(text, registry)).toEqual([`section "decide": ${FIX}`]);
  });

  // A last rule whose when doesn't compile is reported for that, not again as a missing catch-all.
  test('a last rule whose when doesn\'t compile gets its own problem alone', () => {
    const problems = Rulebook.check(withSection('  - name: decide\n    when: "true"\n    rules:\n      - when: "TRUE"\n        then: { action: settle }\n'), registry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^section "decide" rule 1 when: /);
  });

  test.each([
    ['ends in when: "true"', '  - name: decide\n    when: "true"\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n      - when: "true"\n        then: { action: settle }\n'],
    ['ends in when: " true " (read from the syntax tree)', '  - name: decide\n    when: "true"\n    rules:\n      - when: " true "\n        then: { action: settle }\n'],
    ['says exhaustive: false', '  - name: decide\n    when: "true"\n    exhaustive: false\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n'],
    ['is ALL', '  - name: decide\n    when: "true"\n    hitPolicy: ALL\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n'],
    ['only gathers', '  - name: gather\n    when: "!has(ws.label)"\n    needs: { label: classify }\n'],
  ])('a section that %s loads', (_label, section) => {
    expect(Rulebook.check(withSection(section), registry)).toEqual([]);
  });

  // A guard can make a when: "true" rule fail, so it isn't a catch-all.
  describe('with a guarded action', () => {
    const guarded = { ...registry, actions: { ...registry.actions, escalate: { writes: ['routing'], guard: 'ws.routing == null', run: async () => {} } } };
    const ending = (action, extra = '') => withSection(`  - name: decide\n    when: "true"\n${extra}    rules:\n      - when: "true"\n        then: { action: ${action} }\n`);

    test('a last when: "true" rule whose action has a guard is refused, naming the action', () => {
      expect(Rulebook.check(ending('escalate'), guarded)).toEqual([
        'section "decide": its last rule\'s action "escalate" has a guard, so the rule may not hold; end in a rule with when: "true" whose action has no guard, or say exhaustive: false',
      ]);
    });

    // A guard that isn't a string is still a guard the author meant; both problems at once.
    test('a guard that isn\'t a string still counts: both problems are reported', () => {
      const listGuard = { ...guarded, actions: { ...guarded.actions, escalate: { ...guarded.actions.escalate, guard: ['ws.routing == null'] } } };
      expect(Rulebook.check(ending('escalate'), listGuard)).toEqual([
        'action "escalate": guard must be a CEL expression (a string)',
        'section "decide": its last rule\'s action "escalate" has a guard, so the rule may not hold; end in a rule with when: "true" whose action has no guard, or say exhaustive: false',
      ]);
    });

    test.each([
      ['an unguarded action', 'settle', ''],
      ['a guarded action, in a section that says exhaustive: false', 'escalate', '    exhaustive: false\n'],
    ])('a last when: "true" rule on %s loads', (_label, action, extra) => {
      expect(Rulebook.check(ending(action, extra), guarded)).toEqual([]);
    });
  });

  test('ALL by the rulebook\'s default is exempt too', () => {
    const text = `version: 1\nhitPolicyDefault: ALL\nsections:\n  - name: decide\n    when: "true"\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n`;
    expect(Rulebook.check(text, registry)).toEqual([]);
  });

  test.each([
    ['an ALL section', '  - name: decide\n    when: "true"\n    hitPolicy: ALL\n    exhaustive: false\n    rules:\n      - when: ws.routing == null\n        then: { action: settle }\n'],
    ['a gather-only section', '  - name: gather\n    when: "!has(ws.label)"\n    exhaustive: false\n    needs: { label: classify }\n'],
  ])('exhaustive on %s is refused: it means nothing there', (_label, section) => {
    const name = section.match(/name: (\w+)/)[1];
    expect(Rulebook.check(withSection(section), registry))
      .toEqual([`section "${name}": exhaustive applies to a FIRST section with rules`]);
  });
});
