import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// The command runs as a consumer runs it: a child process, from the consumer's directory.
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const run = (...args) => {
  const { status, stdout, stderr } = spawnSync(process.execPath, [CLI, ...args], { cwd: FIXTURES, encoding: 'utf-8' });
  return { status, stdout: stdout.trim().split('\n').filter(Boolean), stderr: stderr.trim().split('\n').filter(Boolean) };
};

describe('belaykit-rulebook check', () => {
  test('clean files print ok and exit 0', () => {
    expect(run('check', 'clean.yaml', '--registry', 'registry.js#triageRegistry')).toEqual({
      status: 0,
      stdout: ['clean.yaml: ok'],
      stderr: [],
    });
  });

  test('a broken file prints each problem, prefixed by its file, and exits 1', () => {
    expect(run('check', 'clean.yaml', 'broken.yaml', '--registry', 'registry.js#triageRegistry')).toEqual({
      status: 1,
      stdout: ['clean.yaml: ok'],
      stderr: [
        'broken.yaml: section "triage" rule 1: unknown action "flgg"',
        'broken.yaml: section "triage" when: unknown ws field "itme"',
      ],
    });
  });

  test('a file that does not exist is a problem with that file', () => {
    const { status, stderr } = run('check', 'missing.yaml', '--registry', 'registry.js#triageRegistry');

    expect(status).toBe(1);
    expect(stderr).toEqual(['missing.yaml: no such file']);
  });

  test('a rulebook\'s imports resolve from its own folder, wherever the command runs', () => {
    expect(run('check', 'rules/with-macros.yaml', 'rules/missing-import.yaml', '--registry', 'registry.js#triageRegistry')).toEqual({
      status: 1,
      stdout: ['rules/with-macros.yaml: ok'],
      stderr: ['rules/missing-import.yaml: imports "./gone.macros.yaml": no such file'],
    });
  });

  test('a macro file is checked as one: a macro nothing calls yet fails the check, the rulebooks pass', () => {
    expect(run('check', 'rules/with-macros.yaml', 'rules/triage.macros.yaml', 'rules/stale.macros.yaml', '--registry', 'registry.js#triageRegistry')).toEqual({
      status: 1,
      stdout: ['rules/with-macros.yaml: ok', 'rules/triage.macros.yaml: ok'],
      stderr: ['rules/stale.macros.yaml: macro "isStale": unknown ws field "itme" (a macro file knows the keys its registry names: initialKeys, writes and shapes)'],
    });
  });

  test('a macro file whose imports lead back to it is a cycle, named from it', () => {
    expect(run('check', 'rules/loop-a.macros.yaml', '--registry', 'registry.js#triageRegistry').stderr).toEqual([
      'rules/loop-a.macros.yaml: imports form a cycle: loop-a.macros.yaml -> loop-b.macros.yaml -> loop-a.macros.yaml',
    ]);
  });

  test('a registry module without the named export exits 1, naming it', () => {
    expect(run('check', 'clean.yaml', '--registry', 'registry.js#organizeRegistry')).toEqual({
      status: 1,
      stdout: [],
      stderr: ['belaykit-rulebook: registry.js has no export "organizeRegistry"'],
    });
  });

  test('an export that is not a registry exits 1, naming it', () => {
    expect(run('check', 'clean.yaml', '--registry', 'registry.js#notARegistry').stderr).toEqual([
      'belaykit-rulebook: registry.js export "notARegistry" is not a registry (it needs producers and actions)',
    ]);
  });

  test('a path that cannot be read is that file\'s problem, and the other files are still checked', () => {
    expect(run('check', '..', 'clean.yaml', '--registry', 'registry.js#triageRegistry')).toEqual({
      status: 1,
      stdout: ['clean.yaml: ok'],
      stderr: ['..: cannot read (EISDIR)'],
    });
  });

  test('a registry module that does not exist exits 1, naming it', () => {
    const { status, stderr } = run('check', 'clean.yaml', '--registry', 'nowhere.js#triageRegistry');

    expect(status).toBe(1);
    expect(stderr[0]).toMatch(/^belaykit-rulebook: .*nowhere\.js/);
  });

  test('--registry without an export name exits 1 with the expected form', () => {
    expect(run('check', 'clean.yaml', '--registry', 'registry.js').stderr).toEqual([
      'belaykit-rulebook: --registry must be <module>#<export>, got "registry.js"',
    ]);
  });

  test('a missing --registry or command prints usage and exits 1', () => {
    for (const args of [['check', 'clean.yaml'], ['lint', 'clean.yaml', '--registry', 'registry.js#triageRegistry'], []]) {
      const { status, stderr } = run(...args);

      expect(status).toBe(1);
      expect(stderr[0]).toMatch(/^Usage: belaykit-rulebook check/);
    }
  });
});
