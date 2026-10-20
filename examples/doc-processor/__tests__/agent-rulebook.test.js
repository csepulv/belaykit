import { describe, expect, test } from 'vitest';
import { makeCodeProcessor } from '../src/agent-code.js';
import { makeRulebookProcessor } from '../src/agent-rulebook.js';
import { map, MUSIC_FLAGS, recorded, recordedModel, sample } from './helpers.js';
import { describeProcessor } from './processor-contract.js';

describeProcessor('rulebook', makeRulebookProcessor);

const run = (makeProcessor, name, answers = recorded(name)) =>
  makeProcessor(map, { askJson: recordedModel(answers).askJson }).run(sample(name));

describe('with and without a rulebook, the same answer', () => {
  const cases = {
    'music-notes': recorded('music-notes'),
    'weekend-notes': recorded('weekend-notes'),
    'weekend-notes, a failed classification': { ...recorded('weekend-notes'), classifications: [recorded('weekend-notes').classifications[0], { error: 'refused' }, recorded('weekend-notes').classifications[2]] },
  };

  test.each(Object.keys(cases))('%s: the results are equal, and so are the traces but for how the segmentation is gathered', async (label) => {
    const name = label.split(',')[0];
    const [code, rulebook] = await Promise.all([run(makeCodeProcessor, name, cases[label]), run(makeRulebookProcessor, name, cases[label])]);

    expect(rulebook.status).toBe('completed');
    expect(rulebook.result).toEqual(code.result);
    const gathering = (trace) => trace.map((entry) => (entry.set === 'segment' ? { ...entry, fired: ['(segment)'] } : entry));
    expect(gathering(rulebook.trace)).toEqual(gathering(code.trace));
  });
});

describe('the rulebook version\'s trace (selectFirst, a finalizer and a tracer, together)', () => {
  test('the finalizer\'s result, and each iteration\'s step, what fired and the snippet a rule selected', async () => {
    const outcome = await run(makeRulebookProcessor, 'music-notes');
    const steps = outcome.trace.map(({ set, fired, snippet }) => `${set}${snippet === undefined ? '' : `[${snippet}]`}: ${fired.join(', ')}`);

    expect(outcome.status).toBe('completed');
    expect(outcome.result.flags).toEqual(MUSIC_FLAGS);
    expect(outcome.result.snippets.map(({ n, type }) => `${n}:${type}`)).toEqual(['1:review', '2:task', '3:idea', '4:idea', '5:question', '6:question', '7:quote']);
    expect(steps).toEqual([
      'segment: gather segmentation', 'check: accept',
      'classify[0]: classify', 'review[0]: mark_reviewed',
      'classify[1]: classify', 'review[1]: mark_reviewed',
      'classify[2]: classify', 'review[2]: mark_reviewed',
      'classify[3]: classify', 'review[3]: flag_new_themes, mark_reviewed',
      'classify[4]: classify', 'review[4]: mark_reviewed',
      'classify[5]: classify', 'review[5]: drop_unknown_topics, flag_ambiguity, mark_reviewed',
      'classify[6]: classify', 'review[6]: mark_reviewed',
    ]);
    expect(outcome.trace.every((entry) => Object.keys(entry).every((key) => ['set', 'fired', 'snippet'].includes(key)))).toBe(true);
  });
});
