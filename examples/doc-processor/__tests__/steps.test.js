import { describe, expect, test } from 'vitest';
import { checkChoices } from '../src/steps.js';
import { recorded, sample } from './helpers.js';

describe('the code check', () => {
  const [bad, good] = recorded('weekend-notes').segmentations;
  const matches = async (ws) => Object.fromEntries(await Promise.all(checkChoices({ resegment: () => {} })
    .map(async ({ name, criteria }) => [name, (await criteria(ws)).matched])));

  test('each choice matches on its own terms, whatever the mode it runs in', async () => {
    const ws = (segmentation, retries) => ({ document: sample('weekend-notes'), segmentation, retries });

    expect(await matches(ws(good, 0))).toEqual({ accept: true, 're-segment': false, fail: false });
    expect(await matches(ws(bad, 0))).toEqual({ accept: false, 're-segment': true, fail: false });
    expect(await matches(ws(bad, 1))).toEqual({ accept: false, 're-segment': false, fail: true });
  });

  test('a re-segment counts the retry and passes the reasons on', async () => {
    const asked = [];
    const resegment = checkChoices({ resegment: (ws) => asked.push(ws.feedback) })[1];
    const ws = { document: sample('weekend-notes'), segmentation: bad, retries: 0, feedback: [] };

    await resegment.actions[0](ws, await resegment.criteria(ws));

    expect(ws.retries).toBe(1);
    expect(asked).toEqual([[expect.stringMatching(/^line 7 is not labelled/)]]);
  });
});
