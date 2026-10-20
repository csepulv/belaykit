import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { main } from '../src/cli.js';
import { recorded, recordedModel } from './helpers.js';

const MUSIC = fileURLToPath(new URL('../samples/music-notes.md', import.meta.url));

function runCli(args, { env = { ANTHROPIC_API_KEY: 'test-key' }, model = recordedModel(recorded('music-notes')) } = {}) {
  const out = [];
  const err = [];
  return main(args, { env, askJson: model.askJson, out: (text) => out.push(text), err: (text) => err.push(text) })
    .then((code) => ({ code, out: out.join(''), err: err.join(''), calls: model.calls }));
}

describe('the live command', () => {
  test('without a document it prints its usage and exits 1', async () => {
    const { code, err } = await runCli([]);

    expect(code).toBe(1);
    expect(err).toMatch(/^Usage: node src\/cli\.js <document> \[--rulebook\] \[--map <topic-map\.yaml>\]/);
  });

  test('without ANTHROPIC_API_KEY it says so and calls no model', async () => {
    const { code, err, calls } = await runCli([MUSIC], { env: {} });

    expect(code).toBe(1);
    expect(err).toBe('ANTHROPIC_API_KEY is required for a live run — set it in your environment\n');
    expect(calls).toEqual([]);
  });

  test.each([[[]], [['--rulebook']]])('processes a document %j and prints the result as JSON', async (flags) => {
    const { code, out } = await runCli([MUSIC, ...flags]);

    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.snippets).toHaveLength(7);
    expect(result.flags).toHaveLength(3);
  });

  test('a document whose segmentation fails twice exits 2, with the reasons in the result', async () => {
    const { segmentations, classifications } = recorded('weekend-notes');
    const weekend = fileURLToPath(new URL('../samples/weekend-notes.md', import.meta.url));
    const { code, out } = await runCli([weekend], { model: recordedModel({ segmentations: [segmentations[0], segmentations[0]], classifications }) });

    expect(code).toBe(2);
    expect(JSON.parse(out).failed.errors[0]).toMatch(/^line 7 is not labelled/);
  });
});

describe('the live command, when something is wrong', () => {
  test('a missing document, an unknown flag or a broken map is a message and exit 1, never a stack trace', async () => {
    const missing = await runCli(['nope.md']);
    const flag = await runCli([MUSIC, '--verbose']);
    const badMap = await runCli([MUSIC, '--map', MUSIC]);

    expect(missing).toMatchObject({ code: 1, err: expect.stringMatching(/^doc-processor: ENOENT: no such file or directory, open 'nope\.md'\n$/) });
    expect(flag).toMatchObject({ code: 1, err: expect.stringMatching(/^doc-processor: Unknown option '--verbose'/) });
    expect(badMap).toMatchObject({ code: 1, err: expect.stringMatching(/^doc-processor: topic map: /) });
  });

  test('a long document is not cut short by the iteration limit: it is sized to the document', async () => {
    const lines = Array.from({ length: 150 }, (_, index) => `- note ${index + 1}`);
    const dir = await import('node:fs').then(({ mkdtempSync }) => mkdtempSync(join(tmpdir(), 'doc-processor-')));
    const long = join(dir, 'long.md');
    writeFileSync(long, lines.join('\n'));
    const model = recordedModel({
      segmentations: [{ snippets: lines.map((_, index) => ({ ranges: [{ start: index + 1, end: index + 1 }] })), structural: [], skipped: [] }],
      classifications: lines.map(() => ({ topics: ['music'], type: 'note', themes: [], ambiguity: '' })),
    });

    const { code, out } = await runCli([long], { model });

    expect(code).toBe(0);
    expect(JSON.parse(out).snippets).toHaveLength(150);
  });
});
