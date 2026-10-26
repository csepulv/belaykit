// Since 0.4: cel-js can't read a class instance an expression reaches ("Unsupported type: Clients"). The run still
// fails, and its message names where values of that type are in ws, and what CEL can read.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

class Clients { constructor() { this.count = 2; } }

const textParam = { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false };
const registry = (data) => ({
  producers: { loadData: { writes: ['data'], run: async () => data } },
  actions: {
    settle: { writes: ['routing'], run: async (ws) => { ws.routing = 'hold'; } },
    guarded: { writes: ['routing'], guard: 'ws.data.clients.count > 0', run: async (ws) => { ws.routing = 'hold'; } },
    note: { writes: ['routing'], params: textParam, templates: ['text'], run: async (ws, { params }) => { ws.routing = params.text; } },
  },
});

const UNREADABLE = 'which CEL can\'t read (keep the working set to plain data: objects, lists, strings, numbers, booleans, null, Map, Set, Date)';

// `data` sits in ws.data, which the gathering section's has() reads; the values under test are one level down.
const errorOf = async (data, rule) => {
  const rules = Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: gather
    when: '!has(ws.data)'
    needs: { data: loadData }
  - name: decide
    when: '!has(ws.routing)'
    exhaustive: false
    rules:
      - id: decide_it
${rule}
`, registry(data));
  return (await rules.decide({})).error;
};

describe('a value CEL can\'t read', () => {
  test('reached in has(), the message names where it is in ws', async () => {
    const rules = Rulebook.fromText(`
version: 1
outputs: [routing]
sections:
  - name: gather
    when: '!has(ws.data)'
    needs: { data: loadData }
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - when: "true"
        then: { action: settle }
`, registry(new Clients()));
    expect((await rules.decide({})).error)
      .toBe(`iteration 2 choiceProvider failed: section "gather" when failed: ws.data is an instance of Clients, ${UNREADABLE}`);
  });

  test.each([
    ['deep inside a value', { items: [{ ok: true }, new Clients()] }, '        when: ws.data.items[1].count == 2\n        then: { action: settle }', `ws.data.items[1] is an instance of Clients, ${UNREADABLE}`],
    ['in a guard', { clients: new Clients() }, '        when: "true"\n        then: { action: guarded }', `action "guarded" guard: ws.data.clients is an instance of Clients, ${UNREADABLE}`],
    ['in a selectFirst list', { clients: new Clients() }, '        selectFirst: { c: ws.data.clients }\n        when: "true"\n        then: { action: settle }', `selectFirst: ws.data.clients is an instance of Clients, ${UNREADABLE}`],
    ['in a placeholder', { clients: new Clients() }, '        when: "true"\n        then: { action: note, text: "{ws.data.clients.count}" }', `param "text" placeholder {ws.data.clients.count}: ws.data.clients is an instance of Clients, ${UNREADABLE}`],
    ['as a function', { explain() {} }, '        when: ws.data.explain == null\n        then: { action: settle }', `ws.data.explain is a function, ${UNREADABLE}`],
  ])('%s, the message names where it is', async (_label, data, rule, message) => {
    expect(await errorOf(data, rule)).toMatch(new RegExp(`${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  test('two values of the type are both named, since which one CEL reached isn\'t known', async () => {
    expect(await errorOf({ a: new Clients(), b: new Clients() }, '        when: ws.data.a.count == 2\n        then: { action: settle }'))
      .toMatch(/ws\.data\.a, ws\.data\.b are each an instance of Clients \(CEL reached one of them\), which CEL can't read/);
  });

  test('a selected item is named before the rest of ws', async () => {
    const data = { items: [new Clients()], other: new Clients() };
    expect(await errorOf(data, '        selectFirst: { c: ws.data.items }\n        when: c.count == 2\n        then: { action: settle }'))
      .toMatch(/: c, ws\.data\.other are each an instance of Clients \(CEL reached one of them\)/);
  });

  // cel-js says "object" for a map whose own `constructor` key isn't a class; no value can be named by that.
  test('cel-js\'s "object" and its other errors keep their own message', async () => {
    expect(await errorOf({ meta: { constructor: 'x' }, empty: null }, '        when: ws.data.meta.size() > 0\n        then: { action: settle }'))
      .toMatch(/Unsupported type: object$/);
    expect(await errorOf({ count: 1 }, '        when: ws.data.missing == 1\n        then: { action: settle }'))
      .toMatch(/No such key: missing$/);
  });
});
