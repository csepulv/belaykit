// Since 0.2: a rulebook as a decision function. It declares its outputs, and
// `rules.decide(initial)` runs until every output is present, or says why not.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: {
    classify: {
      writes: ['label'],
      run: async (ws, deps) => {
        if (deps.fail) throw new Error('classifier down');
        return deps.label;
      },
    },
  },
  actions: {
    settle: {
      writes: ['routing', 'reason'],
      params: { type: 'object', properties: { routing: { type: 'string' }, reason: { type: 'string' } }, additionalProperties: false },
      run: async (ws, { params }) => { ws.routing = params.routing; ws.reason = params.reason; },
    },
  },
  initialKeys: ['item'],
};

const TRIAGE = (outputs = '[routing, reason]') => `
version: 1
outputs: ${outputs}
sections:
  - name: gather
    when: '!has(ws.label) && ws.item != "skip"'
    needs: { label: classify }
  - name: decide
    when: '!has(ws.routing) && ws.item != "skip"'
    rules:
      - id: urgent
        when: ws.label.urgent == true
        then: { action: settle, routing: escalate, reason: urgent }
      - id: hold
        when: "true"
        then: { action: settle, routing: hold, reason: ordinary }
`;

describe('a rulebook\'s outputs', () => {
  test('declared outputs, each written by an action, load', () => {
    expect(Rulebook.check(TRIAGE(), registry)).toEqual([]);
  });

  test('an output no action writes is refused', () => {
    expect(Rulebook.check(TRIAGE('[routing, reason, owner]'), registry)).toEqual(['output "owner": no action writes it']);
  });

  test('an output a producer writes is refused: gathering would set it', () => {
    const producerWrites = { ...registry, producers: { classify: { ...registry.producers.classify, writes: ['label', 'routing'] } } };
    expect(Rulebook.check(TRIAGE(), producerWrites)).toEqual(['output "routing" is written by producer "classify", which would set it before any rule decides']);
  });

  test('an output that is a needs key is refused: its producer would set it', () => {
    expect(Rulebook.check(TRIAGE('[routing, label]'), registry)).toEqual(['output "label" is a needs key; its producer would set it']);
  });

  test.each([
    ['empty', '[]'],
    ['repeated', '[routing, routing]'],
    ['misnamed', '[Routing]'],
  ])('a list of outputs that is %s is refused', (_label, outputs) => {
    const problems = Rulebook.check(TRIAGE(outputs), registry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^outputs/);
  });
});

describe('rules.decide', () => {
  const rules = Rulebook.fromText(TRIAGE(), registry);

  test.each([
    ['an urgent case', { urgent: true }, { routing: 'escalate', reason: 'urgent' }, ['gather label', 'urgent']],
    ['an ordinary case', { urgent: false }, { routing: 'hold', reason: 'ordinary' }, ['gather label', 'hold']],
  ])('%s resolves completed with the outputs, deps reaching the producer', async (_label, label, outputs, fired) => {
    const decision = await rules.decide({ item: 'x' }, { deps: { label } });
    expect(decision.status).toBe('completed');
    expect(decision.outputs).toEqual(outputs);
    expect(decision.trace.flatMap((entry) => entry.fired)).toEqual(fired);
    expect(decision).not.toHaveProperty('error');
  });

  test('a case no section takes resolves no_match, naming the unset outputs and each section\'s when', async () => {
    const decision = await rules.decide({ item: 'skip' }, { deps: { label: { urgent: true } } });
    expect(decision.status).toBe('no_match');
    expect(decision.error).toBe('decide: no section decided; unset outputs: routing, reason; sections: gather (when false), decide (when false)');
    expect(decision).not.toHaveProperty('outputs');
  });

  test('a section that claims and matches nothing (exhaustive: false) resolves no_match, saying so', async () => {
    const text = TRIAGE().replace('      - id: hold\n        when: "true"\n        then: { action: settle, routing: hold, reason: ordinary }\n', '').replace("    when: '!has(ws.routing)", "    exhaustive: false\n    when: '!has(ws.routing)");
    const decision = await Rulebook.fromText(text, registry).decide({ item: 'x' }, { deps: { label: { urgent: false } } });
    expect(decision.status).toBe('no_match');
    expect(decision.error).toBe('decide: no section decided; unset outputs: routing, reason; sections: gather (when false), decide (when true, no rule held)');
  });

  // The message describes what the provider asked: the sections up to the one that claimed.
  test.each([
    ['a gather section that stays true after gathering', `
version: 1
outputs: [routing]
sections:
  - name: gather
    when: "true"
    needs: { label: classify }
  - name: decide
    when: "true"
    rules:
      - when: "true"
        then: { action: settle, routing: hold, reason: x }
`, 'unset outputs: routing; sections: gather (when true, nothing left to gather), decide (not reached)'],
    ['a section that claims and matches nothing, before another whose when holds', `
version: 1
outputs: [routing]
sections:
  - name: first
    when: '!has(ws.routing)'
    exhaustive: false
    rules:
      - when: ws.item == "never"
        then: { action: settle, routing: hold, reason: x }
  - name: second
    when: "true"
    rules:
      - when: "true"
        then: { action: settle, routing: hold, reason: x }
`, 'unset outputs: routing; sections: first (when true, no rule held), second (not reached)'],
  ])('with %s, no_match names only the sections asked', async (_label, text, described) => {
    const decision = await Rulebook.fromText(text, registry).decide({ item: 'x' }, { deps: { label: {} } });
    expect(decision.status).toBe('no_match');
    expect(decision.error).toBe(`decide: no section decided; ${described}`);
  });

  test('deps reach the actions too', async () => {
    const withDeps = { ...registry, actions: { settle: { ...registry.actions.settle, run: async (ws, { deps }) => { ws.routing = deps.routing; ws.reason = 'from deps'; } } } };
    const decision = await Rulebook.fromText(TRIAGE(), withDeps).decide({ item: 'x' }, { deps: { label: { urgent: true }, routing: 'deps-routing' } });
    expect(decision.outputs).toEqual({ routing: 'deps-routing', reason: 'from deps' });
  });

  // An invalid option value is the caller's mistake, like an unknown option.
  test('an invalid maxIterations is a TypeError', async () => {
    await expect(rules.decide({ item: 'x' }, { maxIterations: 0 })).rejects.toThrow(TypeError);
  });

  test('a producer that throws resolves failed, with the core\'s message', async () => {
    const decision = await rules.decide({ item: 'x' }, { deps: { fail: true } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('gather/gather label action failed: classifier down');
  });

  test.each([
    ['an output', { item: 'x', routing: 'hold' }, 'decide: output "routing" is already present'],
    ['a needs key', { item: 'x', label: null }, 'initialize: "label" is a needs key; its producer sets it'],
  ])('an initial working set that already holds %s fails, naming it', async (_label, initial, message) => {
    const decision = await rules.decide(initial, { deps: { label: { urgent: true } } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe(`initializer failed: ${message}`);
  });

  test('maxIterations bounds the run', async () => {
    const decision = await rules.decide({ item: 'x' }, { deps: { label: { urgent: true } }, maxIterations: 1 });
    expect(decision.status).toBe('failed');
    expect(decision.error).toMatch(/1 iteration/);
  });

  test('a rulebook without outputs, or an option decide doesn\'t take, is a TypeError', async () => {
    const plain = Rulebook.fromText(TRIAGE().replace('outputs: [routing, reason]\n', ''), registry);
    await expect(plain.decide({ item: 'x' })).rejects.toThrow(new TypeError('rulebook.decide: this rulebook declares no outputs'));
    await expect(rules.decide({ item: 'x' }, { tracer: false })).rejects.toThrow(new TypeError('rulebook.decide: unknown option "tracer" (options: deps, maxIterations, onCopyLoss)'));
  });
});
