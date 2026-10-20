import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { numberLines, segmentDocument, segmentationSchema } from '../src/segment.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf-8');
const WEEKEND = read('../samples/weekend-notes.md');
const recorded = JSON.parse(read('./recorded/weekend-notes.json'));

const askingJson = (response) => {
  const calls = [];
  return { calls, askJson: async (request) => { calls.push(request); return response; } };
};

describe('segmentDocument', () => {
  test('asks for structure only, over numbered lines, and returns the model\'s answer', async () => {
    const { calls, askJson } = askingJson(recorded.segmentations[1]);

    const segmentation = await segmentDocument(WEEKEND, {}, { askJson });

    expect(segmentation).toBe(recorded.segmentations[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe('segment');
    expect(calls[0].schema).toBe(segmentationSchema);
    expect(calls[0].system).toMatch(/structure only/i);
    expect(calls[0].prompt).toBe(numberLines(WEEKEND));
    expect(calls[0].prompt.split('\n')[2]).toBe('   3| Developed two rolls of Portra in the kitchen darkroom; the second came out underexposed.');
  });

  test('a retry carries the previous attempt\'s errors', async () => {
    const { calls, askJson } = askingJson(recorded.segmentations[1]);

    await segmentDocument(WEEKEND, { feedback: ['line 7 is not labelled: "Need a lens hood…"'] }, { askJson });

    expect(calls[0].prompt).toMatch(/failed these checks — fix them:\n- line 7 is not labelled/);
  });

  test('the recorded segmentations match the schema the model is held to', () => {
    for (const segmentation of recorded.segmentations) expect(segmentationSchema.safeParse(segmentation).success).toBe(true);
  });
});
