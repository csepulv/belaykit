// The topic map: the topics a snippet may be placed in, the themes that run across
// them, and the types a snippet may have. It's the reader's own file, so it is
// checked where it comes in, and every problem is named at once.
import { readFileSync } from 'node:fs';
import { YAMLError, parse as parseYaml } from 'yaml';
import { z } from 'zod';

const SLUG = /^[a-z][a-z0-9_]*$/;
const text = z.string({ error: 'required' });
const slug = text.regex(SLUG, 'a slug is lowercase letters, digits and underscores');

const topicMapSchema = z.object({
  topics: z.array(z.object({
    slug,
    name: text,
    description: text,
    keywords: z.array(z.string()).default([]),
    aliases: z.array(z.string()).default([]),
  })).min(1, 'at least one topic'),
  themes: z.array(slug).default([]),
  types: z.array(z.object({ name: slug, description: text })).min(1, 'at least one type'),
});

export function loadTopicMap(path) {
  return parseTopicMap(readFileSync(path, 'utf-8'));
}

export function parseTopicMap(source) {
  const document = parseMapYaml(source);
  const parsed = topicMapSchema.safeParse(document);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`)),
    ...duplicateSlugs(document?.topics),
  ];
  if (problems.length > 0) throw new Error(problems.map((problem) => `topic map: ${problem}`).join('\n'));
  return parsed.data;
}

// The yaml package throws a YAMLError for bad syntax and a ReferenceError for an alias that
// doesn't resolve; both are problems in the reader's file.
function parseMapYaml(source) {
  try {
    return parseYaml(source);
  } catch (error) {
    if (error instanceof YAMLError || error instanceof ReferenceError) throw new Error(`topic map: YAML: ${error.message.split('\n')[0]}`);
    throw error;
  }
}

function duplicateSlugs(topics) {
  if (!Array.isArray(topics)) return [];
  const slugs = topics.map((topic) => topic?.slug);
  return [...new Set(slugs.filter((candidate, index) => candidate !== undefined && slugs.indexOf(candidate) !== index))]
    .map((repeated) => `topics: slug "${repeated}" is used twice`);
}

export const topicSlugs = (map) => map.topics.map(({ slug: topicSlug }) => topicSlug);
