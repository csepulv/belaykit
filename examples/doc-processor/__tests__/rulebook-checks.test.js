import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadFixture, Rulebook } from '@belaykit/rulebook';
import { RULEBOOK } from '../src/agent-rulebook.js';
import { registry } from '../src/registry.js';
import { finalize, isDocumentDone } from '../src/steps.js';

const EXAMPLE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(EXAMPLE, 'node_modules', '.bin', 'belaykit-rulebook');
const FIXTURES = join(EXAMPLE, 'fixtures');
const RULES = dirname(RULEBOOK);
const MACROS = 'snippets.macros.yaml';

// Runs the rulebook's command as an author would; returns its exit status and output.
function check(file) {
  try {
    return { status: 0, out: execFileSync(CLI, ['check', file, '--registry', 'src/registry.js#registry'], { cwd: EXAMPLE, encoding: 'utf-8', stdio: 'pipe' }) };
  } catch (error) {
    return { status: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

// A copy of the rulebook and the macro file it imports, in a new folder, with `edit` applied to one of them.
// Returns the copied rulebook's path.
function brokenCopy(edit, file = 'doc-processor.rules.yaml') {
  const folder = mkdtempSync(join(tmpdir(), 'doc-processor-'));
  for (const name of ['doc-processor.rules.yaml', MACROS]) {
    const text = readFileSync(join(RULES, name), 'utf-8');
    writeFileSync(join(folder, name), name === file ? edit(text) : text);
  }
  return join(folder, 'doc-processor.rules.yaml');
}

describe('the rulebook passes its checks before it runs', () => {
  test('belaykit-rulebook check passes the rulebook', () => {
    expect(check('rules/doc-processor.rules.yaml')).toEqual({ status: 0, out: 'rules/doc-processor.rules.yaml: ok\n' });
  });

  test('a copy with a misspelled action is refused, naming the section and rule', () => {
    const broken = brokenCopy((text) => text.replace('action: classify_snippet', 'action: classify_snipet'));

    const { status, out } = check(broken);
    expect(status).toBe(1);
    expect(out).toBe(`${broken}: section "classify" rule 1 (classify): unknown action "classify_snipet"\n`);
  });

  // The registry's shape for ws.snippets is z.toJSONSchema of the snippet's own zod schema.
  test('a copy with a misspelled snippet field read through a selectFirst binding is refused', () => {
    const broken = brokenCopy((text) => text.replace('snippet.classification.ambiguity != ""', 'snippet.classification.ambigity != ""'));

    expect(check(broken)).toEqual({ status: 1, out: `${broken}: section "review" rule 2 (flag_ambiguity) when: unknown field "ambigity" on snippet.classification\n` });
  });

  // The macro's param stands for whatever each call passes, so the misspelling is found at both calls,
  // through the CEL macro variable `s` and through the rule's binding `snippet`.
  test('a copy whose macro misspells a snippet field is refused where the macro is called', () => {
    const broken = brokenCopy((text) => text.replace('s.error == null', 's.eror == null'), MACROS);

    expect(check(broken)).toEqual({
      status: 1,
      out: [
        `${broken}: section "classify" rule 1 (classify) when, in macro "unclassified": unknown field "eror" on snippet (an item of ws.snippets)`,
        `${broken}: section "classify" when, in macro "unclassified": unknown field "eror" on s (an item of ws.snippets)`,
        '',
      ].join('\n'),
    });
  });

  test.each(readdirSync(FIXTURES).filter((file) => file.endsWith('.yaml')))('fixture %s runs as it says', async (file) => {
    const rules = Rulebook.load(RULEBOOK, registry);
    const run = await rules.runFixture({ fixture: loadFixture(join(FIXTURES, file)), finishChecker: isDocumentDone, finalizer: finalize });

    expect(run.mismatches).toEqual([]);
  });

  // The registry's guard on classify_snippet: classifying calls the model, and only the code check accepts a
  // segmentation, so no edit to the rulebook can classify a document that wasn't accepted.
  // The rulebook runs alone here, from a working set whose segmentation wasn't accepted; the guard is the same in
  // the full agent, where the code check would have rejected it.
  test('a copy whose classify section no longer waits for acceptance still never calls the model', async () => {
    const edited = readFileSync(RULEBOOK, 'utf-8')
      .replace('when: ws.accepted == true && ws.snippets.exists(s, unclassified(s))', 'when: ws.snippets.exists(s, unclassified(s))');
    const calls = [];
    const classifier = { askJson: async (request) => { calls.push(request); return { topics: [], type: 'note', themes: [], ambiguity: '' }; }, systemPrompt: '', schema: {} };
    const fixture = {
      initial: { document: 'x', topic_slugs: [], theme_slugs: [], retries: 0, feedback: [], flags: [], accepted: false, failed: null,
        snippets: [{ n: 1, header: 'H', text: '- a', error: null, reviewed: false, classification: null }] },
      expect: { status: 'no_match' },
    };
    const run = await Rulebook.fromText(edited, registry, { baseDir: RULES }).runFixture({ fixture, deps: { classifier }, finishChecker: isDocumentDone, finalizer: finalize });

    expect(calls).toEqual([]);
    expect(run.trace.at(-1).evaluated).toEqual([{ choice: 'classify', matched: false, detail: { guard: false } }]);
  });

  test('the ambiguity flag\'s wording comes from the rulebook', async () => {
    const reworded = readFileSync(RULEBOOK, 'utf-8').replace('reason: "ambiguous: {', 'reason: "unclear: {');
    const rules = Rulebook.fromText(reworded, registry, { baseDir: RULES });
    const run = await rules.runFixture({ fixture: loadFixture(join(FIXTURES, 'review-flags.yaml')), finishChecker: isDocumentDone, finalizer: finalize });

    expect(run.result.flags).toContainEqual({ snippet: 2, reason: 'unclear: music, or podcasts?' });
  });

  test('the committed function reference matches the rulebook and its registry', () => {
    const reference = execFileSync(CLI, ['reference', 'rules/doc-processor.rules.yaml', '--registry', 'src/registry.js#registry'], { cwd: EXAMPLE, encoding: 'utf-8' });

    expect(reference).toContain('## unclassified');
    expect(readFileSync(join(EXAMPLE, 'rules', 'functions.md'), 'utf-8')).toBe(reference);
  });
});
