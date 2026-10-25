// Macro files and rulebooks written to a new folder, for the macro tests.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

// Writes each file under a new folder and returns the folder.
export function folderWith(files) {
  const folder = mkdtempSync(join(tmpdir(), 'belaykit-macros-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

// A macro file: each macro is its body, or its whole entry ({ params, body, description }).
export const macroFile = (macros, imports = []) => stringify({
  version: 1,
  ...(imports.length && { imports }),
  macros: Object.fromEntries(Object.entries(macros).map(([name, entry]) => [name, typeof entry === 'string' ? { body: entry } : entry])),
});
