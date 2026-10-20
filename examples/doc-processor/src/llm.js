// The model call: one structured-output request to Claude, whose answer must match a zod
// schema. The agents take it as a dependency (`deps.askJson`), so tests replace it with
// recorded answers and never reach the network. `purpose` ("segment", "classify") labels
// each call; the recorded answers in the tests are kept by it.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_EFFORT = 'medium';

export function makeClient(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for a live run — set it in your environment');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function askJson({ system, prompt, schema, model, effort = DEFAULT_EFFORT }, deps = {}) {
  const { env = process.env } = deps;
  const anthropic = deps.anthropic ?? makeClient(env);
  const response = await anthropic.messages.parse({
    model: model ?? env.DOC_PROCESSOR_MODEL ?? DEFAULT_MODEL,
    max_tokens: 16000,
    // Breakpoint on the system block: calls share the system prompt, not the user prompt.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: zodOutputFormat(schema), effort },
  });
  if (response.stop_reason === 'refusal') throw new Error(`the model refused (${response.stop_details?.category ?? 'no category'})`);
  if (!response.parsed_output) throw new Error(`the model's answer didn't match the schema (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}
