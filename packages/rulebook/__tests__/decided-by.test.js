// Since 0.4: a completed decision names, for each output, the rule whose action last gave it a new value.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const stringParam = (name) => ({ type: 'object', properties: { [name]: { type: 'string' } }, required: [name], additionalProperties: false });

const registry = {
  producers: {
    classify: { writes: ['label'], run: async () => ({ urgent: true }) },
  },
  actions: {
    route: { writes: ['routing'], params: stringParam('routing'), run: async (ws, { params }) => { ws.routing = params.routing; } },
    settle: {
      writes: ['routing', 'reason'],
      params: stringParam('routing'),
      run: async (ws, { params }) => { ws.routing = params.routing; ws.reason = `settled as ${params.routing}`; },
    },
    assign: { writes: ['owner'], run: async (ws) => { ws.owner = 'on-call'; } },
    tag: { writes: ['tagged'], run: async (ws) => { ws.tagged = true; } },
    startTags: { writes: ['tags'], run: async (ws) => { ws.tags = ['first']; } },
    addTag: { writes: ['tags'], run: async (ws) => { ws.tags.push('second'); } },
    fail: { writes: ['routing'], run: async () => { throw new Error('router down'); } },
  },
  initialKeys: ['item'],
};

const decide = (text, initial = { item: 'x' }) => Rulebook.fromText(text, registry).decide(initial);

// The iteration whose trace entry fired `rule`.
const iterationThatFired = (trace, rule) => trace.find((entry) => entry.fired.includes(rule)).iteration;

describe('decidedBy', () => {
  test('names the section, rule and iteration that decided each output', async () => {
    const decision = await decide(`
version: 1
outputs: [routing, owner]
sections:
  - name: route
    when: '!has(ws.routing)'
    needs: { label: classify }
    rules:
      - id: urgent
        when: ws.label.urgent == true
        then: { action: route, routing: escalate }
      - id: ordinary
        when: "true"
        then: { action: route, routing: hold }
  - name: assign
    when: '!has(ws.owner)'
    rules:
      - id: on_call
        when: "true"
        then: { action: assign }
`);
    expect(decision.status).toBe('completed');
    expect(decision.decidedBy).toEqual({
      routing: { section: 'route', rule: 'urgent', iteration: 2 },
      owner: { section: 'assign', rule: 'on_call', iteration: 3 },
    });
    expect(decision.decidedBy.routing.iteration).toBe(iterationThatFired(decision.trace, 'urgent'));
    expect(decision.decidedBy.owner.iteration).toBe(iterationThatFired(decision.trace, 'on_call'));
  });

  test.each([
    ['a case the override takes', 'vip', 'override'],
    ['a case only the default takes', 'x', 'default'],
  ])('in an ALL section, the last rule to give it a new value is named: %s', async (_label, item, rule) => {
    const decision = await decide(`
version: 1
outputs: [routing]
sections:
  - name: settle
    when: '!has(ws.routing)'
    hitPolicy: ALL
    rules:
      - id: default
        when: "true"
        then: { action: route, routing: hold }
      - id: override
        when: ws.item == "vip"
        then: { action: route, routing: escalate }
`, { item });
    expect(decision.decidedBy.routing).toEqual({ section: 'settle', rule, iteration: 1 });
  });

  test('a later rule that writes the value an output already holds isn\'t a new value: the earlier rule stays named', async () => {
    const decision = await decide(`
version: 1
outputs: [routing]
sections:
  - name: settle
    when: '!has(ws.routing)'
    hitPolicy: ALL
    rules:
      - id: default
        when: "true"
        then: { action: route, routing: hold }
      - id: same_again
        when: "true"
        then: { action: route, routing: hold }
`);
    expect(decision.trace[0].fired).toEqual(['default', 'same_again']);
    expect(decision.decidedBy.routing.rule).toBe('default');
  });

  test('a change inside an output\'s own value isn\'t a new value: the rule that assigned it stays named', async () => {
    const decision = await decide(`
version: 1
outputs: [tags]
sections:
  - name: tags
    when: '!has(ws.tags)'
    hitPolicy: ALL
    rules:
      - id: start
        when: "true"
        then: { action: startTags }
      - id: add
        when: "true"
        then: { action: addTag }
`);
    expect(decision.outputs.tags).toEqual(['first', 'second']);
    expect(decision.decidedBy.tags.rule).toBe('start');
  });

  test('one rule deciding two outputs is named for both, and a rule without an id by the name the trace gives it', async () => {
    const decision = await decide(`
version: 1
outputs: [routing, reason, tagged]
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - id: settle
        when: "true"
        then: { action: settle, routing: hold }
  - name: tag
    when: '!has(ws.tagged)'
    rules:
      - id: never
        when: ws.item == "never"
        then: { action: tag }
      - when: "true"
        then: { action: tag }
`);
    expect(decision.decidedBy).toEqual({
      routing: { section: 'decide', rule: 'settle', iteration: 1 },
      reason: { section: 'decide', rule: 'settle', iteration: 1 },
      tagged: { section: 'tag', rule: 'tag#2', iteration: 2 },
    });
    expect(Object.keys(decision.decidedBy)).toEqual(['routing', 'reason', 'tagged']);
    expect(decision.trace[1].fired).toEqual(['tag#2']);
  });

  test.each([
    ['no_match', `
version: 1
outputs: [routing]
sections:
  - name: decide
    when: ws.item == "never"
    rules:
      - when: "true"
        then: { action: route, routing: hold }
`],
    ['failed, after a rule decided one output,', `
version: 1
outputs: [routing, owner]
sections:
  - name: route
    when: '!has(ws.routing)'
    rules:
      - when: "true"
        then: { action: route, routing: hold }
  - name: assign
    when: '!has(ws.owner)'
    rules:
      - when: "true"
        then: { action: fail }
`],
  ])('a %s decision has no decidedBy', async (label, text) => {
    const decision = await decide(text);
    expect(decision.status).toBe(label.split(',')[0]);
    expect(decision).not.toHaveProperty('decidedBy');
  });
});

describe('an output no rule decided', () => {
  // A producer's declared writes can't name an output (the loader refuses it), so this is one writing beyond them.
  test('fails the decision, naming the output, rather than completing without its decidedBy', async () => {
    const sneaky = { ...registry, producers: { classify: { writes: ['label'], run: async (ws) => { ws.routing = 'hold'; return { urgent: false }; } } } };
    const decision = await Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: gather
    when: '!has(ws.label)'
    needs: { label: classify }
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - when: "true"
        then: { action: route, routing: hold }
`, sneaky).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: output "routing" wasn\'t set by a rule\'s action (something else wrote it, such as a producer beyond the key it gathers)');
    expect(decision).not.toHaveProperty('outputs');
    expect(decision).toHaveProperty('evidence', {});
  });

  // A registered function that writes ws while a `when` is evaluated, and returns false: nothing matches, yet the
  // output is present, so "unset outputs" would list nothing.
  test('on a no_match run, an output something else wrote fails the decision too, after the run\'s message', async () => {
    const stamping = { ...registry, functions: [{ signature: 'stamp(map): bool', handler: (ws) => { ws.routing = 'by function'; return false; } }] };
    const decision = await Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: decide
    when: '!has(ws.routing)'
    exhaustive: false
    rules:
      - when: stamp(ws)
        then: { action: route, routing: hold }
`, stamping).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: no section decided; unset outputs: none; sections: decide (when true, no rule held)'
      + '; decide: output "routing" wasn\'t set by a rule\'s action (something else wrote it, such as a producer beyond the key it gathers)');
  });

  test('on a no_match run, the run\'s message comes first, then the undecided output, then a copy problem', async () => {
    const stamping = { ...registry, functions: [{ signature: 'stamp(map): bool', handler: (ws) => { ws.routing = 'by function'; ws.tagged = () => 'tag'; return false; } }] };
    const decision = await Rulebook.fromText(`
version: 1
outputs: [routing]
evidence: [tagged]
sections:
  - name: decide
    when: '!has(ws.routing)'
    exhaustive: false
    rules:
      - when: stamp(ws)
        then: { action: route, routing: hold }
`, stamping).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toMatch(/^decide: no section decided; [^;]+; [^;]+; decide: output "routing" wasn't set by a rule's action \([^)]*\); decide: evidence "tagged" can't be copied \(/);
  });

  test('beside a copy problem, the undecided output comes first, and both are named', async () => {
    const sneaky = { ...registry, producers: { classify: { writes: ['label'], run: async (ws) => { ws.routing = () => 'hold'; return { urgent: false }; } } } };
    const decision = await Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: gather
    when: '!has(ws.label)'
    needs: { label: classify }
`, sneaky).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toMatch(/^decide: output "routing" wasn't set by a rule's action \([^)]*\); decide: output "routing" can't be copied \(.* could not be cloned\.\)$/);
  });
});

describe('rulebook.provider()', () => {
  test('its rule actions run as before', async () => {
    const rules = Rulebook.fromText(`
version: 1
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - when: "true"
        then: { action: route, routing: hold }
`, registry);
    const ws = rules.initialize({ item: 'x' });
    const set = await rules.provider()(ws);
    await set.choices[0].actions[0](ws, { matched: true });
    expect(ws).toEqual({ item: 'x', routing: 'hold' });
  });
});
