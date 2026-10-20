import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildSystemPrompt, classificationSchemaFor, classifySnippet } from '../src/classify.js';
import { loadTopicMap } from '../src/topic-map.js';

const map = loadTopicMap(fileURLToPath(new URL('../samples/topic-map.yaml', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('./recorded/music-notes.json', import.meta.url), 'utf-8'));

describe('the classifier', () => {
  test('its system prompt lists every topic, theme and type from the map', () => {
    const prompt = buildSystemPrompt(map);

    expect(prompt).toMatch(/\| photography \| Photography \| Cameras, film and lenses/);
    expect(prompt).toMatch(/\| books \| Books \| .* \| novel, author, chapter, reading list, paperback \| reading \|/);
    expect(prompt).toMatch(/analog_revival, adaptations, criticism, gear, collecting/);
    expect(prompt).toMatch(/- review: A judgement of a specific work\./);
  });

  test('a type outside the map\'s list doesn\'t pass the schema; a topic or theme outside it does, to be flagged', () => {
    const schema = classificationSchemaFor(map);

    expect(schema.safeParse({ topics: ['podcasts'], type: 'question', themes: ['film_scores'], ambiguity: '' }).success).toBe(true);
    expect(schema.safeParse({ topics: ['music'], type: 'essay', themes: [], ambiguity: '' }).success).toBe(false);
    for (const classification of recorded.classifications) expect(schema.safeParse(classification).success).toBe(true);
  });

  test('classifies one snippet with the run\'s system prompt and the snippet in the user prompt', async () => {
    const calls = [];
    const askJson = async (request) => { calls.push(request); return recorded.classifications[0]; };
    const snippet = { n: 1, header: 'Listening', text: '- Spent the weekend with the new Big Thief album on vinyl.' };

    const classification = await classifySnippet(snippet, { askJson, systemPrompt: 'SYSTEM', schema: classificationSchemaFor(map) });

    expect(classification).toBe(recorded.classifications[0]);
    expect(calls[0]).toMatchObject({ purpose: 'classify', system: 'SYSTEM' });
    expect(calls[0].prompt).toBe('Section: Listening\n\nSnippet:\n- Spent the weekend with the new Big Thief album on vinyl.');
  });
});
