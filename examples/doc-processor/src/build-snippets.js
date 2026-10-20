// Turns a segmentation (structure only: line ranges and labels) into snippets. The
// model never supplies text — each snippet's text is sliced from the document, so it
// is literal by construction. checkSegmentation is the gate that decides whether a
// segmentation is usable at all: every non-blank line has exactly one label, and each
// label is true for where its line sits.
import { z } from 'zod';
import { classificationShape } from './classify.js';

const HEADING = /^#{1,6}\s/;
const RULE = /^---\s*$/;

// A snippet as the working set holds it; the registry gives it to the rulebook as a shape.
export const snippetSchema = z.object({
  n: z.number().int(),
  header: z.string(),
  text: z.string(),
  classification: classificationShape.nullable(),
  error: z.string().nullable(),
  reviewed: z.boolean(),
});

// CRLF or LF; a snippet's text never keeps a "\r".
export const documentLines = (document) => document.split(/\r?\n/);
const quote = (text) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;
const span = ({ start, end }) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset);

export function checkSegmentation(document, segmentation) {
  const lines = documentLines(document);
  const errors = [];
  const labels = new Map();
  const label = (line, name) => labels.set(line, [...(labels.get(line) ?? []), name]);
  const inDocument = (line) => Number.isInteger(line) && line >= 1 && line <= lines.length;
  const textOf = (line) => lines[line - 1];

  // Bounds-checked before expanding, so a bogus range can't allocate the world.
  const rangeLines = (owner, ranges) => ranges.flatMap(({ start, end }) => {
    if (start > end) {
      errors.push(`${owner} has reversed range ${start}-${end}`);
      return [];
    }
    if (!inDocument(start) || !inDocument(end)) {
      errors.push(`${owner} has range ${start}-${end} outside lines 1-${lines.length}`);
      return [];
    }
    return span({ start, end });
  });

  segmentation.snippets.forEach((snippet, index) => {
    const owner = `snippet ${index + 1}`;
    const content = rangeLines(owner, snippet.ranges);
    if (content.length === 0) errors.push(`${owner} has no lines`);
    else if (content.every((line) => !textOf(line).trim())) errors.push(`${owner} has only blank lines`);
    for (const line of content) {
      label(line, owner);
      if (HEADING.test(textOf(line)) || RULE.test(textOf(line))) errors.push(`${owner} contains heading line ${line}: ${quote(textOf(line))}`);
    }
  });

  for (const line of segmentation.structural) {
    if (!inDocument(line)) {
      errors.push(`structural line ${line} is outside lines 1-${lines.length}`);
      continue;
    }
    label(line, 'structural');
    if (!HEADING.test(textOf(line)) && !RULE.test(textOf(line))) {
      errors.push(`line ${line} is labelled structural but is not a heading or "---": ${quote(textOf(line))}`);
    }
  }

  segmentation.skipped.forEach((entry, index) => {
    const owner = `skipped ${index + 1}`;
    const content = rangeLines(owner, entry.ranges);
    if (content.length === 0) errors.push(`${owner} has no lines`);
    for (const line of content) label(line, owner);
  });

  lines.forEach((text, index) => {
    const line = index + 1;
    const names = labels.get(line) ?? [];
    if (text.trim() && names.length === 0) errors.push(`line ${line} is not labelled: ${quote(text)}`);
    if (names.length > 1) errors.push(`line ${line} is labelled more than once (${names.join(', ')}): ${quote(text)}`);
  });
  return errors;
}

// Assumes checkSegmentation passed. Snippets are numbered in document order. A snippet's
// header is the nearest heading above it, read from the document too.
export function buildSnippets(document, segmentation) {
  const lines = documentLines(document);
  return segmentation.snippets
    .map((snippet) => snippet.ranges.flatMap(span).sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .map((lineNumbers, index) => ({
      n: index + 1,
      header: headingAbove(lines, lineNumbers[0]),
      text: trimBlankEnds(lineNumbers.map((line) => lines[line - 1])).join('\n'),
      classification: null,
      error: null,
      reviewed: false,
    }));
}

function headingAbove(lines, line) {
  const heading = lines.slice(0, line - 1).findLast((text) => HEADING.test(text));
  return heading === undefined ? '' : heading.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim();
}

function trimBlankEnds(texts) {
  const first = texts.findIndex((text) => text.trim());
  const last = texts.findLastIndex((text) => text.trim());
  return first === -1 ? [] : texts.slice(first, last + 1);
}
