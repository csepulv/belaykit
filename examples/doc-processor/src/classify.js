// Classification of one snippet against the topic map. The system prompt is the same
// for every snippet of a run, so it can be cached; the snippet goes in the user prompt.
// A type must come from the map; a topic or theme outside it is allowed through, so the
// review step can flag it rather than lose it.
import { z } from 'zod';
import { askJson as askJsonDefault } from './llm.js';

const classificationOf = (type) => z.object({
  topics: z.array(z.string()).max(3),
  type,
  themes: z.array(z.string()).max(3),
  ambiguity: z.string(),
});

export const classificationSchemaFor = (map) => classificationOf(z.enum(map.types.map(({ name }) => name)));

// The same fields for any map, for describing a snippet in the working set (build-snippets.js).
export const classificationShape = classificationOf(z.string());

const RULES = `You place snippets from a reader's notes in their topic map. Return:

- topics: 1-3 topic slugs from the TOPICS table, only where the snippet is about that topic. A passing
  mention doesn't count. Use a slug that isn't in the table only when no topic fits; it will be flagged.
- type: one of the TYPES, by what the snippet is, not where it sits.
- themes: threads that run across topics, at most 3. Most snippets get none or one. Reuse a theme from
  the THEMES list; coin a new snake_case slug only when nothing fits — new themes are flagged for review.
- ambiguity: "" whenever you could choose the topics with reasonable confidence, which is most of the
  time. Fill it in only when you could not choose, naming the candidates.`;

export function buildSystemPrompt(map) {
  return [
    RULES,
    '',
    '# TOPICS',
    '',
    '| slug | name | description | keywords | aliases |',
    '|---|---|---|---|---|',
    ...map.topics.map(({ slug, name, description, keywords, aliases }) =>
      `| ${slug} | ${name} | ${description} | ${keywords.join(', ')} | ${aliases.join(', ')} |`.replace(/\n+/g, ' ')),
    '',
    '# THEMES',
    '',
    map.themes.join(', '),
    '',
    '# TYPES',
    '',
    ...map.types.map(({ name, description }) => `- ${name}: ${description}`),
  ].join('\n');
}

export const buildSnippetPrompt = ({ header, text }) =>
  [header ? `Section: ${header}\n` : null, 'Snippet:', text].filter((line) => line !== null).join('\n');

export async function classifySnippet(snippet, { askJson = askJsonDefault, systemPrompt, schema }) {
  return askJson({ purpose: 'classify', system: systemPrompt, prompt: buildSnippetPrompt(snippet), schema });
}
