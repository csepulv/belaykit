// Recorded model answers stand in for the live model: each `segment` call takes the
// next recorded segmentation, each `classify` call the next classification. An entry
// `{ "error": "…" }` makes that call throw, as a refusal or a schema miss would.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTopicMap } from '../src/topic-map.js';

export const map = loadTopicMap(fileURLToPath(new URL('../samples/topic-map.yaml', import.meta.url)));
export const sample = (name) => readFileSync(new URL(`../samples/${name}.md`, import.meta.url), 'utf-8');
export const recorded = (name) => JSON.parse(readFileSync(new URL(`./recorded/${name}.json`, import.meta.url), 'utf-8'));

export function recordedModel({ segmentations, classifications }) {
  const queues = { segment: [...segmentations], classify: [...classifications] };
  const calls = [];
  const askJson = async (request) => {
    calls.push(request);
    const answer = queues[request.purpose].shift();
    if (answer === undefined) throw new Error(`no recorded ${request.purpose} answer left`);
    if (answer.error) throw new Error(answer.error);
    return structuredClone(answer);
  };
  return { askJson, calls };
}

export const MUSIC_FLAGS = [
  { snippet: 4, reason: 'new theme: film_scores' },
  { snippet: 6, reason: 'unknown topic: podcasts' },
  { snippet: 6, reason: 'ambiguous: A podcast reviewing a tour: music, or a topic the map doesn\'t have.' },
];
