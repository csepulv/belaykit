// Templated params: an action lists the params whose text a rule may fill from the case
// (`templates: ['message']`), and a rule writes placeholders, CEL inside braces:
// `message: "{ws.customer.name} reported this {ws.facts.count} times"`.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const PARAMS = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'What to send' },
    urgency: { type: 'string', enum: ['low', 'high'] },
    note: { type: 'string' },
  },
  required: ['message'],
};

const followUp = (overrides = {}) => ({ writes: ['sent'], params: PARAMS, templates: ['message'], run: async () => {}, ...overrides });
const registryWith = (action) => ({ producers: {}, actions: { follow_up: action }, initialKeys: ['customer', 'facts', 'sent'] });

const rulebookText = (then) => `
version: 1
sections:
  - name: decide
    when: ws.sent == null
    exhaustive: false
    rules:
      - id: ask
        when: "true"
        then: ${then}
`;

describe('an action\'s templates', () => {
  const problemsFor = (action) => Rulebook.check(rulebookText('{ action: follow_up, message: "hi" }'), registryWith(action));

  test('listing a plain string param loads', () => {
    expect(problemsFor(followUp())).toEqual([]);
  });

  test.each([
    ['the action has no params', { params: undefined, templates: ['message'] }, 'action "follow_up" templates: the action takes no params'],
    ['a name isn\'t a param', { templates: ['mesage'] }, 'action "follow_up" templates: "mesage" isn\'t one of its params'],
    ['a name is empty', { templates: [''] }, 'action "follow_up" templates: "" isn\'t one of its params'],
    ['a name is listed twice', { templates: ['message', 'message'] }, 'action "follow_up" templates: "message" is listed twice'],
    ['a param isn\'t a plain string', { templates: ['urgency'] }, 'action "follow_up" templates: "urgency" must be a plain string in its params schema (type "string", with no enum, pattern or other limit on its value)'],
    ['templates isn\'t a list', { templates: 'message' }, 'action "follow_up" templates: must be a list of param names'],
  ])('is refused when %s', (_label, overrides, problem) => {
    const action = followUp(overrides);
    if (overrides.params === undefined && 'params' in overrides) delete action.params;
    const problems = problemsFor(action);
    expect(problems).toContain(problem);
    expect(problems.filter((each) => each.startsWith('action "follow_up" templates'))).toEqual([problem]);
  });
});

// One mistake in the registry is reported once, not again for each rule that it affects.
describe('a registry problem isn\'t repeated for the rules it affects', () => {
  const place = 'section "decide" rule 1 (ask)';
  const problemsFor = (action, then) => Rulebook.check(rulebookText(then), registryWith(action));

  test('a misspelled templates key', () => {
    const { templates, ...rest } = followUp();
    expect(problemsFor({ ...rest, template: templates }, '{ action: follow_up, message: "Dear {ws.customer.name}" }'))
      .toEqual(['action "follow_up": unknown key "template" (keys: writes, params, templates, guard, run; pass dependencies through deps)']);
  });

  test('templates naming a param that doesn\'t exist', () => {
    expect(problemsFor(followUp({ templates: ['mesage'] }), '{ action: follow_up, message: "hi", mesage: "{x}" }')).toEqual([
      'action "follow_up" templates: "mesage" isn\'t one of its params',
      `${place}: param "mesage" isn't one "follow_up" takes`,
    ]);
  });

  test('an action without params', () => {
    const { params, templates, ...rest } = followUp();
    expect(problemsFor(rest, '{ action: follow_up, message: "Dear {ws.customer.name}" }'))
      .toEqual([`${place}: "follow_up" takes no params, but the rule passes "message"`]);
  });
});

// The case fills the template just before the action runs; a value that can't be
// text fails the run, naming the rule, the param and the placeholder.
describe('templates are filled when the action runs', () => {
  const receivedBy = () => {
    const received = [];
    const action = followUp({ run: async (ws, { params }) => { received.push(params); ws.sent = true; } });
    return { received, registry: { ...registryWith(action), initialKeys: ['customer', 'facts', 'sent', 'items'] } };
  };
  const runWith = async (then, initial, { selectFirst } = {}) => {
    const { received, registry } = receivedBy();
    const rules = Rulebook.fromText(`
version: 1
sections:
  - name: decide
    when: ws.sent == null
    exhaustive: false
    rules:
      - id: ask
${selectFirst ? `        selectFirst: ${selectFirst}\n` : ''}        when: "true"
        then: ${then}
`, registry);
    const run = await rules.runFixture({
      fixture: { initial: { sent: null, items: [], ...initial }, expect: { status: 'completed' } },
      finishChecker: (ws) => ws.sent === true,
    });
    return { run, received, rules };
  };

  test('strings, numbers and booleans become text, and literal braces are unescaped', async () => {
    const message = '"{ws.customer.name} reported this {ws.facts.count} times ({{ref}}), ratio {ws.facts.ratio}, {2}, {ws.facts.ok}"';
    const { run, received, rules } = await runWith(`{ action: follow_up, message: ${message}, urgency: high }`,
      { customer: { name: 'Ada' }, facts: { count: 3, ratio: 1.5, ok: true } });
    expect(run.status).toBe('completed');
    expect(received).toEqual([{ message: 'Ada reported this 3 times ({ref}), ratio 1.5, 2, true', urgency: 'high' }]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(rules.sections[0].rules[0].params.message).toBe('{ws.customer.name} reported this {ws.facts.count} times ({{ref}}), ratio {ws.facts.ratio}, {2}, {ws.facts.ok}');
  });

  test('a default is written in the placeholder', async () => {
    const then = '{ action: follow_up, message: "{belaykit.present(ws, \\"facts.reason\\") ? ws.facts.reason : \\"unknown\\"}" }';
    const { received } = await runWith(then, { customer: {}, facts: {} });
    expect(received).toEqual([{ message: 'unknown' }]);
  });

  test('a selectFirst rule\'s template reads its item', async () => {
    const { received } = await runWith('{ action: follow_up, message: "about {item.tag}" }', { customer: {}, facts: {}, items: [{ tag: 'billing' }] }, { selectFirst: '{ item: ws.items }' });
    expect(received).toEqual([{ message: 'about billing' }]);
  });

  test.each([
    ['null', null, 'evaluated to null'],
    ['a list', ['Ada'], 'evaluated to a list'],
    ['a map', { first: 'Ada' }, 'evaluated to a map'],
  ])('a value that is %s fails the run, naming the rule, param and placeholder, and the action never runs', async (_label, name, what) => {
    const { run, received } = await runWith('{ action: follow_up, message: "Dear {ws.customer.name}" }', { customer: { name }, facts: {} });
    expect(run.status).toBe('failed');
    expect(run.error).toBe(`decide/ask action failed: param "message" placeholder {ws.customer.name}: ${what}, expected a string, number or boolean`);
    expect(received).toEqual([]);
  });

  // cel-js's uint, timestamp and duration are objects; each is named for what it is.
  test.each([
    ['a uint', '{dyn(1u)}', 'evaluated to a uint'],
    ['a timestamp', '{dyn(timestamp("2026-10-21T00:00:00Z"))}', 'evaluated to a timestamp'],
    ['a duration', '{dyn(duration("1h"))}', 'evaluated to a duration'],
  ])('a value that is %s fails the run, named as such', async (_label, placeholder, what) => {
    const { run } = await runWith(`{ action: follow_up, message: ${JSON.stringify(placeholder)} }`, { customer: {}, facts: {} });
    expect(run.status).toBe('failed');
    expect(run.error).toBe(`decide/ask action failed: param "message" placeholder ${placeholder}: ${what}, expected a string, number or boolean`);
  });

  // An action made from a class may define templates on its prototype; it is filled all the same.
  test('an action whose templates is a getter on its class is filled', async () => {
    const received = [];
    class FollowUp {
      get templates() { return ['message']; }
      writes = ['sent'];
      params = PARAMS;
      async run(ws, { params }) { received.push(params); ws.sent = true; }
    }
    const rules = Rulebook.fromText(rulebookText('{ action: follow_up, message: "Dear {ws.customer.name}" }'),
      { ...registryWith(new FollowUp()), initialKeys: ['customer', 'facts', 'sent'] });
    await rules.runFixture({ fixture: { initial: { sent: null, customer: { name: 'Ada' }, facts: {} }, expect: { status: 'completed' } }, finishChecker: (ws) => ws.sent === true });
    expect(received).toEqual([{ message: 'Dear Ada' }]);
  });

  test('a missing key fails the run the same way', async () => {
    const { run, received } = await runWith('{ action: follow_up, message: "Dear {ws.customer.name}" }', { customer: {}, facts: {} });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('decide/ask action failed: param "message" placeholder {ws.customer.name}: No such key: name');
    expect(received).toEqual([]);
  });
});

// A placeholder is checked at load like any `when`, and a brace can't pass silently.
describe('placeholders are checked at load', () => {
  const place = 'section "decide" rule 1 (ask)';
  const shaped = {
    ...registryWith(followUp({ params: { ...PARAMS, properties: { ...PARAMS.properties, details: { type: 'object' } } } })),
    initialKeys: ['customer', 'facts', 'sent', 'items'],
    shapes: {
      customer: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
      items: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false } },
    },
  };
  const problemsOf = (message, { rest = '', selectFirst } = {}) => Rulebook.check(`
version: 1
sections:
  - name: decide
    when: ws.sent == null
    exhaustive: false
    rules:
      - id: ask
${selectFirst ? `        selectFirst: ${selectFirst}\n` : ''}        when: "true"
        then: { action: follow_up, message: ${JSON.stringify(message)}${rest} }
`, shaped);

  test.each([
    ['fields and text', 'Dear {ws.customer.name}, about {ws.facts.count} reports'],
    ['literal braces', 'ref {{42}} and }}'],
    ['a brace inside a CEL string', '{"}" + ws.customer.name + "{"}'],
    ['a map literal', '{ {"a": "}"}["a"] }'],
    ['a raw string', '{r"\\}" + "x"}'],
    // In cel-js a raw string's \" doesn't end it.
    ['a raw string with \\"', '{r"\\"}" + "x"}'],
    // A CEL comment runs to the end of its line, braces included.
    ['a comment', '{ws.customer.name // a } note\n}'],
    ['a triple-quoted string', '{\'\'\'a}b\'\'\'}'],
    ['a default through belaykit.present', '{belaykit.present(ws, "customer.name") ? ws.customer.name : "there"}'],
    ['no placeholder at all', 'Thanks for writing'],
  ])('%s loads', (_label, message) => {
    expect(problemsOf(message)).toEqual([]);
  });

  test('a selectFirst binding is in scope', () => {
    expect(problemsOf('about {item.tag}', { selectFirst: '{ item: ws.items }' })).toEqual([]);
    expect(problemsOf('about {item.tg}', { selectFirst: '{ item: ws.items }' }))
      .toEqual([`${place} param "message" placeholder {item.tg}: unknown field "tg" on item (an item of ws.items)`]);
  });

  test.each([
    ['a misspelled field', '{ws.customer.nme}', 'placeholder {ws.customer.nme}: unknown field "nme" on ws.customer'],
    ['an unknown key', '{ws.custmer}', 'placeholder {ws.custmer}: unknown ws field "custmer"'],
    ['an unknown function', '{app_x(1)}', 'placeholder {app_x(1)}: unknown function "app_x"'],
    ['a misspelled present path', '{belaykit.present(ws, "customer.nme") ? "a" : "b"}',
      'placeholder {belaykit.present(ws, "customer.nme") ? "a" : "b"}: belaykit.present "customer.nme": unknown field "nme" on ws.customer'],
    ['a list', '{[1, 2]}', 'placeholder {[1, 2]}: has type list<int>, expected text (a string, number or boolean)'],
    ['null', '{null}', 'placeholder {null}: has type null, expected text (a string, number or boolean)'],
    ['a uint', '{1u}', 'placeholder {1u}: has type uint, expected text (a string, number or boolean)'],
    ['a comment that swallows the closing brace', '{ws.customer.name // note} hi', ': an unclosed { (write {{ for a brace)'],
    ['an unclosed brace', 'Dear {ws.customer.name', ': an unclosed { (write {{ for a brace)'],
    ['a lone closing brace', 'a } b', ': a lone } (write }} for a brace)'],
    ['an empty placeholder', 'a {} b', ': an empty placeholder {}'],
    ['a blank placeholder', 'a {  } b', ': an empty placeholder {}'],
    // `{{` is a literal brace, so a map literal right after the opening brace isn't read as a placeholder.
    ['a map literal right after the brace', '{{"a": 1}["a"]}', ': a lone } (write }} for a brace)'],
  ])('%s is refused, placed by param and placeholder', (_label, message, problem) => {
    const separator = problem.startsWith(':') ? '' : ' ';
    expect(problemsOf(message)).toEqual([`${place} param "message"${separator}${problem}`]);
  });

  // Two problems in one input are both reported.
  test('two placeholders\' problems are both reported', () => {
    expect(problemsOf('{ws.customer.nme} and {ws.customer.nam}')).toEqual([
      `${place} param "message" placeholder {ws.customer.nme}: unknown field "nme" on ws.customer`,
      `${place} param "message" placeholder {ws.customer.nam}: unknown field "nam" on ws.customer`,
    ]);
  });

  // A scanning problem doesn't hide the placeholders before it.
  test('a placeholder\'s problem and a scanning problem in one param are both reported', () => {
    expect(problemsOf('{ws.custmer} }')).toEqual([
      `${place} param "message" placeholder {ws.custmer}: unknown ws field "custmer"`,
      `${place} param "message": a lone } (write }} for a brace)`,
    ]);
  });

  test.each([
    ['at the top level', ', note: "{ws.customer.name}"', 'note'],
    ['nested', ', details: { text: "a { b" }', 'details'],
  ])('a brace in a param the action doesn\'t template is refused, %s', (_label, rest, param) => {
    expect(problemsOf('hi', { rest })).toEqual([`${place}: param "${param}" has a brace, but "follow_up" doesn't template "${param}"`]);
  });
});
