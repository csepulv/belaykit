// What both versions of the agent must do, as one suite run against each.
// `makeProcessor(map, deps)` returns a configured BelayKit Agent.
import { describe, expect, test } from 'vitest';
import { map, MUSIC_FLAGS, recorded, recordedModel, sample } from './helpers.js';

export function describeProcessor(name, makeProcessor) {
  const process = (document, model) => makeProcessor(map, { askJson: model.askJson }).run(document);

  describe(`${name}: a document becomes placed, typed snippets`, () => {
    test('music-notes: seven snippets, each sliced from the document, placed and typed, with flags', async () => {
      const document = sample('music-notes');
      const outcome = await process(document, recordedModel(recorded('music-notes')));

      expect(outcome.status).toBe('completed');
      const { snippets, flags, failed } = outcome.result;
      expect(failed).toBeNull();
      expect(snippets.map(({ n, topics, type, themes }) => ({ n, topics, type, themes }))).toEqual([
        { n: 1, topics: ['music'], type: 'review', themes: ['analog_revival'] },
        { n: 2, topics: ['music'], type: 'task', themes: ['collecting'] },
        { n: 3, topics: ['music'], type: 'idea', themes: [] },
        { n: 4, topics: ['music', 'movies'], type: 'idea', themes: ['film_scores'] },
        { n: 5, topics: ['movies'], type: 'question', themes: ['collecting'] },
        { n: 6, topics: [], type: 'question', themes: ['criticism'] },
        { n: 7, topics: ['music'], type: 'quote', themes: [] },
      ]);
      expect(snippets.every(({ text }) => document.includes(text))).toBe(true);
      expect(snippets[6]).toMatchObject({ header: 'Quote', text: '> "Without music, life would be a mistake." — Nietzsche' });
      expect(flags).toEqual(MUSIC_FLAGS);
    });
  });

  describe(`${name}: a bad segmentation is retried with feedback, then failed`, () => {
    test('a segmentation that misses a line is asked for again, with the reason, and the second one is used', async () => {
      const model = recordedModel(recorded('weekend-notes'));
      const outcome = await process(sample('weekend-notes'), model);

      const segmentCalls = model.calls.filter(({ purpose }) => purpose === 'segment');
      expect(segmentCalls).toHaveLength(2);
      expect(segmentCalls[1].prompt).toMatch(/failed these checks — fix them:\n- line 7 is not labelled: "Need a lens hood/);
      expect(outcome.result.snippets.map(({ n, topics }) => `${n}:${topics.join('+')}`)).toEqual(['1:photography', '2:books+movies', '3:photography']);
    });

    test('two bad segmentations fail the document, with the reasons and no snippets', async () => {
      const { segmentations, classifications } = recorded('weekend-notes');
      const outcome = await process(sample('weekend-notes'), recordedModel({ segmentations: [segmentations[0], segmentations[0]], classifications }));

      expect(outcome.status).toBe('completed');
      expect(outcome.result.snippets).toEqual([]);
      expect(outcome.result.failed).toEqual({ errors: [expect.stringMatching(/^line 7 is not labelled: "Need a lens hood/)] });
    });

    test('a segmenter call that throws counts as a failed attempt', async () => {
      const { segmentations, classifications } = recorded('weekend-notes');
      const outcome = await process(sample('weekend-notes'), recordedModel({ segmentations: [{ error: 'the model refused (cyber)' }, segmentations[1]], classifications }));

      expect(outcome.result.failed).toBeNull();
      expect(outcome.result.snippets).toHaveLength(3);
    });
  });

  describe(`${name}: a model answer that repeats itself`, () => {
    test('a topic or theme named twice counts once', async () => {
      const { segmentations, classifications } = recorded('weekend-notes');
      const repeating = [{ topics: ['photography', 'photography'], type: 'note', themes: ['film_stock', 'film_stock'], ambiguity: '' }, ...classifications.slice(1)];
      const outcome = await process(sample('weekend-notes'), recordedModel({ segmentations, classifications: repeating }));

      expect(outcome.result.snippets[0]).toMatchObject({ topics: ['photography'], themes: ['film_stock'] });
      expect(outcome.result.flags).toEqual([{ snippet: 1, reason: 'new theme: film_stock' }]);
    });
  });

  describe(`${name}: one snippet's failed model call doesn't lose the others`, () => {
    test('snippet 2 is marked with its error and flagged; 1 and 3 are classified; the run completes', async () => {
      const { segmentations, classifications } = recorded('weekend-notes');
      const failing = [classifications[0], { error: 'the model refused (cyber)' }, classifications[2]];
      const outcome = await process(sample('weekend-notes'), recordedModel({ segmentations, classifications: failing }));

      expect(outcome.status).toBe('completed');
      expect(outcome.result.snippets.map(({ n, topics, error }) => ({ n, topics, error }))).toEqual([
        { n: 1, topics: ['photography'], error: null },
        { n: 2, topics: [], error: 'classify failed: the model refused (cyber)' },
        { n: 3, topics: ['photography'], error: null },
      ]);
      expect(outcome.result.flags).toEqual([{ snippet: 2, reason: 'classify failed: the model refused (cyber)' }]);
    });
  });
}
