// The public docs speak v0.1's vocabulary only. These are names and phrases from
// before v0.1. "Strategy" has a v0.1 meaning (everything an author supplies), defined in the
// glossary; anywhere else it is too easily read in its old, narrow sense (a provider).
import { describe, expect, test } from 'vitest';
import { publicDocs, readDoc } from '../src/docs.js';

const RETIRED = [
  /\bmakeAgent\b/, /\bisFinished\b/, /\byamlProvider\b/, /\bloadStageFile/, /\bcheckStageFile\b/, /\binitializeWorkingSet\b/,
  /\bstage files?\b/i, /\bstages:/, /yaml-cel/, /\bRunResult\b/, /\bTraceHook\b/, /\bPartialChoiceProvider\b/, /\bStageFile\b/,
  /^(?!\| Strategy \|).*\bstrateg/i,
];

describe('the public docs\' vocabulary', () => {
  test.each(publicDocs())('%s uses no retired name', (path) => {
    const { source } = readDoc(path);
    const lines = source.split('\n');
    const hits = lines.flatMap((line, index) => RETIRED.filter((pattern) => pattern.test(line)).map((pattern) => `${index + 1}: ${pattern} in "${line.trim().slice(0, 80)}"`));
    expect(hits).toEqual([]);
  });
});
