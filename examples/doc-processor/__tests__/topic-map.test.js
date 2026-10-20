import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTopicMap, parseTopicMap } from '../src/topic-map.js';

const SAMPLE = fileURLToPath(new URL('../samples/topic-map.yaml', import.meta.url));

describe('the topic map', () => {
  test('the sample loads: four topics, five themes, six types', () => {
    const map = loadTopicMap(SAMPLE);

    expect(map.topics.map(({ slug }) => slug)).toEqual(['photography', 'books', 'music', 'movies']);
    expect(map.themes).toEqual(['analog_revival', 'adaptations', 'criticism', 'gear', 'collecting']);
    expect(map.types.map(({ name }) => name)).toEqual(['idea', 'question', 'task', 'note', 'review', 'quote']);
    expect(map.topics[1]).toEqual({
      slug: 'books', name: 'Books', description: 'Novels and nonfiction, authors, reading lists and book clubs.',
      keywords: ['novel', 'author', 'chapter', 'reading list', 'paperback'], aliases: ['reading'],
    });
  });

  test('keywords, aliases and themes are optional', () => {
    const map = parseTopicMap('topics: [{ slug: jazz, name: Jazz, description: Jazz. }]\ntypes: [{ name: note, description: A note. }]\n');

    expect(map).toEqual({ topics: [{ slug: 'jazz', name: 'Jazz', description: 'Jazz.', keywords: [], aliases: [] }], themes: [], types: [{ name: 'note', description: 'A note.' }] });
  });

  test('a map that is wrong is refused, naming each problem', () => {
    const text = 'topics: [{ slug: Jazz Club, name: Jazz }, { slug: rock, name: Rock, description: Rock. }, { slug: rock, name: Rock again, description: Again. }]\ntypes: []\n';

    expect(() => parseTopicMap(text)).toThrow(
      'topic map: topics.0.slug: a slug is lowercase letters, digits and underscores\n'
      + 'topic map: topics.0.description: required\n'
      + 'topic map: types: at least one type\n'
      + 'topic map: topics: slug "rock" is used twice',
    );
  });
});

test('YAML that doesn\'t parse is a topic-map problem, not the parser\'s raw error', () => {
  expect(() => parseTopicMap('topics: [unclosed')).toThrow(/^topic map: YAML: /);
  expect(() => parseTopicMap('topics: *nope\n')).toThrow(/^topic map: YAML: /);
});
