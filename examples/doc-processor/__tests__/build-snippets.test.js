import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildSnippets, checkSegmentation } from '../src/build-snippets.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf-8');
const MUSIC = read('../samples/music-notes.md');
const [musicSegmentation] = JSON.parse(read('./recorded/music-notes.json')).segmentations;

const segmentation = (overrides) => ({ ...structuredClone(musicSegmentation), ...overrides });

describe('checkSegmentation', () => {
  test('a segmentation that labels every non-blank line once, truthfully, passes', () => {
    expect(checkSegmentation(MUSIC, musicSegmentation)).toEqual([]);
  });

  test('an unlabelled line, or one labelled twice, is named with its text', () => {
    const dropped = segmentation({ snippets: musicSegmentation.snippets.slice(0, -1) });
    const doubled = segmentation({ structural: [...musicSegmentation.structural, 10] });

    expect(checkSegmentation(MUSIC, dropped)).toEqual(['line 20 is not labelled: "> "Without music, life would be a mistake." — Nietzsche"']);
    expect(checkSegmentation(MUSIC, doubled)).toEqual([
      'line 10 is labelled structural but is not a heading or "---": "- Keep a log of every concert this year, with the setlist..."',
      'line 10 is labelled more than once (snippet 3, structural): "- Keep a log of every concert this year, with the setlist..."',
    ]);
  });

  test('a snippet that holds a heading, has no lines, or a range off the document is refused', () => {
    const broken = segmentation({
      snippets: [
        ...musicSegmentation.snippets,
        { ranges: [{ start: 8, end: 8 }] },
        { ranges: [] },
        { ranges: [{ start: 30, end: 31 }, { start: 4, end: 2 }] },
      ],
      structural: [1, 3, 13, 18],
    });

    expect(checkSegmentation(MUSIC, broken)).toEqual([
      'snippet 8 contains heading line 8: "## Ideas"',
      'snippet 9 has no lines',
      'snippet 10 has range 30-31 outside lines 1-21',
      'snippet 10 has reversed range 4-2',
      'snippet 10 has no lines',
    ]);
  });

  test('skipped lines count as labelled, and need a reason', () => {
    const skipping = segmentation({ snippets: musicSegmentation.snippets.slice(0, -1), skipped: [{ ranges: [{ start: 20, end: 20 }], reason: 'a quote, not a note' }] });

    expect(checkSegmentation(MUSIC, skipping)).toEqual([]);
  });
});

describe('buildSnippets', () => {
  test('each snippet\'s text is sliced from the document, numbered in document order, unclassified', () => {
    const shuffled = segmentation({ snippets: [...musicSegmentation.snippets].reverse() });
    const snippets = buildSnippets(MUSIC, shuffled);

    expect(snippets).toHaveLength(7);
    expect(snippets[0]).toEqual({
      n: 1, header: 'Listening', classification: null, error: null, reviewed: false,
      text: '- Spent the weekend with the new Big Thief album on vinyl; the quiet tracks hold up better than the singles.',
    });
    expect(snippets.map(({ n, header }) => `${n} ${header}`)).toEqual(['1 Listening', '2 Listening', '3 Ideas', '4 Ideas', '5 Questions', '6 Questions', '7 Quote']);
    expect(snippets.every(({ text }) => MUSIC.includes(text))).toBe(true);
  });

  test('a snippet over several ranges keeps its lines in order, joined', () => {
    const [snippet] = buildSnippets(MUSIC, { snippets: [{ ranges: [{ start: 15, end: 16 }, { start: 5, end: 5 }] }], structural: [], skipped: [] });

    expect(snippet.text.split('\n').map((line) => line.slice(0, 8))).toEqual(['- Spent ', '1. Is th', '2. Which']);
  });
});

describe('what the model can\'t write', () => {
  test('a snippet of only blank lines is refused', () => {
    const blank = segmentation({ snippets: [...musicSegmentation.snippets, { ranges: [{ start: 12, end: 12 }] }] });

    expect(checkSegmentation(MUSIC, blank)).toEqual(['snippet 8 has only blank lines']);
  });

  test('a snippet\'s header is the nearest heading above it, from the document, whatever the model says', () => {
    const claimed = segmentation({ snippets: musicSegmentation.snippets.map((snippet) => ({ ...snippet, header: 'Invented heading' })) });

    expect(buildSnippets(MUSIC, claimed).map(({ header }) => header)).toEqual(['Listening', 'Listening', 'Ideas', 'Ideas', 'Questions', 'Questions', 'Quote']);
    expect(buildSnippets('- before any heading\n# Later', { snippets: [{ ranges: [{ start: 1, end: 1 }] }], structural: [2], skipped: [] })[0].header).toBe('');
  });

  test('CRLF line endings are not kept in a snippet\'s text', () => {
    const crlf = MUSIC.replaceAll('\n', '\r\n');

    expect(checkSegmentation(crlf, musicSegmentation)).toEqual([]);
    expect(buildSnippets(crlf, musicSegmentation).map(({ text }) => text)).toEqual(buildSnippets(MUSIC, musicSegmentation).map(({ text }) => text));
  });
});
