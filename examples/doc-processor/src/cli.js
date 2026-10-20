#!/usr/bin/env node
// Process one document live: segment it, place and type each snippet against a topic map,
// and print the agent's result as JSON. Needs ANTHROPIC_API_KEY; the tests use recorded
// answers instead. Exit 0 when the document was processed, 2 when its segmentation
// failed (the reasons are in the result), 1 for any other problem, with a message.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeCodeProcessor } from './agent-code.js';
import { makeRulebookProcessor } from './agent-rulebook.js';
import { documentLines } from './build-snippets.js';
import { askJson as liveAskJson, makeClient } from './llm.js';
import { loadTopicMap } from './topic-map.js';

const SAMPLE_MAP = fileURLToPath(new URL('../samples/topic-map.yaml', import.meta.url));
const USAGE = [
  'Usage: node src/cli.js <document> [--rulebook] [--map <topic-map.yaml>]',
  '  --rulebook  run the rulebook version (default: the code-only version)',
  '  --map       the topic map (default: samples/topic-map.yaml)',
].join('\n');

export async function main(args, deps = {}) {
  const { err = (text) => process.stderr.write(text) } = deps;
  try {
    return await processDocument(args, deps);
  } catch (error) {
    err(`doc-processor: ${error.message.split('\n').join('\n  ')}\n`);
    return 1;
  }
}

async function processDocument(args, deps) {
  const { env = process.env, out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = deps;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { rulebook: { type: 'boolean' }, map: { type: 'string' } } });
  if (positionals.length !== 1) {
    err(`${USAGE}\n`);
    return 1;
  }
  // Checked before any work, so a missing key never shows up as a failed segmentation.
  if (!env.ANTHROPIC_API_KEY) {
    err('ANTHROPIC_API_KEY is required for a live run — set it in your environment\n');
    return 1;
  }
  const map = loadTopicMap(values.map ?? SAMPLE_MAP);
  const document = readFileSync(positionals[0], 'utf-8');
  const outcome = await makeProcessor(values.rulebook, map, deps, env, document).run(document);
  if (outcome.status !== 'completed') throw new Error(outcome.error?.message ?? outcome.status);
  out(`${JSON.stringify(outcome.result, null, 2)}\n`);
  return outcome.result.failed ? 2 : 0;
}

// One agent per document here, so the iteration guard can be sized to it: a document has
// at most one snippet per line, each takes two iterations (classify, review), and segmenting
// takes at most four (two segmentations, two checks).
function makeProcessor(withRulebook, map, deps, env, document) {
  const client = deps.askJson ? null : makeClient(env);
  const askJson = deps.askJson ?? ((request) => liveAskJson(request, { env, anthropic: client }));
  const maxIterations = 2 * documentLines(document).length + 4;
  return (withRulebook ? makeRulebookProcessor : makeCodeProcessor)(map, { askJson }, { maxIterations });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
