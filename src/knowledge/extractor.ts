import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { KnowledgeProvider } from '../config.js';

export interface ExtractionInput {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userContent: string;
}

export interface ExtractionResult {
  text: string;
  model: string;
  provider: KnowledgeProvider;
}

export async function extractKnowledge(input: ExtractionInput): Promise<ExtractionResult> {
  if (input.provider === 'anthropic') {
    return extractWithAnthropic(input);
  }
  return extractWithOpenAI(input);
}

async function extractWithAnthropic(input: ExtractionInput): Promise<ExtractionResult> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const msg = await client.messages.create({
    model: input.model,
    max_tokens: 1024,
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userContent }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model: input.model, provider: 'anthropic' };
}

async function extractWithOpenAI(input: ExtractionInput): Promise<ExtractionResult> {
  const client = new OpenAI({ apiKey: input.apiKey });
  const completion = await client.chat.completions.create({
    model: input.model,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userContent },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? '';
  return { text, model: input.model, provider: 'openai' };
}

export const DEFAULT_SYSTEM_PROMPT = `You are a technical knowledge extractor. Given a git commit and related AI agent session transcripts, extract concise, reusable knowledge.

Output a short Markdown entry with these sections (omit any that have nothing worth noting):

## What was built
One sentence describing the change.

## Key decisions
Bullet points: non-obvious choices, trade-offs, or constraints that shaped the implementation.

## Patterns & techniques
Reusable patterns, idioms, or approaches demonstrated in the session.

## Gotchas
Things that were tricky, counter-intuitive, or caused confusion — what a future developer should know.

Be terse. Skip boilerplate. If there is nothing notable for a section, omit it entirely.`;
