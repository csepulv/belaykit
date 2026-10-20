// Whole-document segmentation. The model sees the document with numbered lines and
// returns structure only — line ranges and labels, never text — so snippet text stays
// literal (build-snippets.js slices it) and checkSegmentation can verify it.
import { z } from 'zod';
import { documentLines } from './build-snippets.js';
import { askJson as askJsonDefault } from './llm.js';

const lineRange = z.object({ start: z.number().int(), end: z.number().int() });

export const segmentationSchema = z.object({
  snippets: z.array(z.object({ ranges: z.array(lineRange) })),
  structural: z.array(z.number().int()),
  skipped: z.array(z.object({ ranges: z.array(lineRange), reason: z.string() })),
});

export const SEGMENT_SYSTEM = `You segment one document into snippets: self-contained notes, ideas, questions,
tasks, reviews or quotes that a reader would file on their own.
Return STRUCTURE ONLY — line numbers and labels. Never copy, rewrite or summarize text.

# Label every non-blank line exactly once
- snippet: inside exactly one snippet's ranges
- structural: headings ("#" to "######") and "---" rules
- skipped: lines that must produce nothing, with a reason (boilerplate, signatures, noise)
Blank lines need no label.

# Snippets
- A list item is usually one snippet; a nested list belongs to the item above it.
- A paragraph is one snippet, unless it holds clearly separate thoughts.
- A quote and its attribution are one snippet.

# Never
- Never put a heading inside a snippet.
- Never create a snippet from text that is not in the document.

Line numbers are the numbers shown before "|".`;

export const numberLines = (document) =>
  documentLines(document).map((text, index) => `${String(index + 1).padStart(4)}| ${text}`).join('\n');

export async function segmentDocument(document, { feedback = [] } = {}, deps = {}) {
  const { askJson = askJsonDefault } = deps;
  const retryNote = feedback.length
    ? `\n\nYour previous segmentation of this document failed these checks — fix them:\n${feedback.map((error) => `- ${error}`).join('\n')}`
    : '';
  return askJson({
    purpose: 'segment',
    system: SEGMENT_SYSTEM,
    prompt: `${numberLines(document)}${retryNote}`,
    schema: segmentationSchema,
  });
}
