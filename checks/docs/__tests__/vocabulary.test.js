// The public docs speak the current vocabulary only. These are names and phrases from
// earlier versions. "Strategy" has a v0.1 meaning (everything an author supplies), defined in the
// glossary; anywhere else it is too easily read in its old, narrow sense (a provider).
// The upgrading page names what changed between versions on purpose, so it alone is exempt.
import { describe, expect, test } from 'vitest';
import { publicDocs, readDoc, repoPathOf } from '../src/docs.js';

const NAMES_OLD_VOCABULARY = repoPathOf('documentation/upgrading.md');

const RETIRED = [
  /\bmakeAgent\b/, /\bisFinished\b/, /\byamlProvider\b/, /\bloadStageFile/, /\bcheckStageFile\b/, /\binitializeWorkingSet\b/,
  /\bstage files?\b/i, /\bstages:/, /yaml-cel/, /\bRunResult\b/, /\bTraceHook\b/, /\bPartialChoiceProvider\b/, /\bStageFile\b/,
  /^(?!\| Strategy \|).*\bstrateg/i,
  // Since 0.2: a needs key is gathered when present; the plugin keeps no `gathered` list.
  /in ws\.gathered/, /`gathered` list/, /`needs` and `gathered`/, /gathered: \[/,
];

describe('the public docs\' vocabulary', () => {
  test('the upgrading page is among the public docs (so the exemption below names a real page)', () => {
    expect(publicDocs()).toContain(NAMES_OLD_VOCABULARY);
  });

  test.each(publicDocs().filter((path) => path !== NAMES_OLD_VOCABULARY))('%s uses no retired name', (path) => {
    const { source } = readDoc(path);
    const lines = source.split('\n');
    const hits = lines.flatMap((line, index) => RETIRED.filter((pattern) => pattern.test(line)).map((pattern) => `${index + 1}: ${pattern} in "${line.trim().slice(0, 80)}"`));
    expect(hits).toEqual([]);
  });
});
