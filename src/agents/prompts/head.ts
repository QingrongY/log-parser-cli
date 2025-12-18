/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const HEAD_SYSTEM_PROMPT =
  `Task: derive ONE JavaScript regex that matches ALL provided log lines and captures the remainder as (?<content>.*).
Definitions:
- "head" = the stable prefix needed to locate a reliable boundary.
- "content" = everything after that boundary (capture as (?<content>...)).
Output JSON only: {"pattern": "<JavaScript regex pattern>"}`;

export const HEAD_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['pattern'],
  additionalProperties: false,
  properties: {
    pattern: { type: 'string' },
  },
};

export interface HeadPromptOptions {
  samples: string[];
  newSamples?: string[];
  previousPattern?: string;
}

export interface HeadPromptBundle {
  systemPrompt: string;
  userPrompt: string;
}

const sanitizeLines = (lines: string[]): string[] =>
  lines
    .filter((line) => line && line.trim().length > 0)
    .map((line) => line.trim());

const dedupeAndShuffle = (lines: string[]): string[] => {
  const unique = Array.from(new Set(lines));
  const shuffled = [...unique];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

export const buildHeadPrompt = (params: HeadPromptOptions): string => {
  const lines = sanitizeLines(params.samples);
  const newLines = sanitizeLines(params.newSamples ?? []);

  const combined = dedupeAndShuffle([...lines, ...newLines]);
  const numbered = combined.map((line, idx) => `${idx + 1}. ${line}`).join('\n');

  const parts = [
    params.previousPattern
      ? `Previous pattern (FAILED to match all samples). Use it only as a starting point; revise or replace as needed.` +
        'Consider either shrinking the head to reduce overfitting, or generalizing the head to better cover observed variants.\n' +
        `${params.previousPattern}`
      : '',
    'Return ONE pattern that matches every log.',
    'Logs:',
    numbered,
  ].filter(Boolean);

  return parts.join('\n\n');
};

export const buildHeadPromptBundle = (params: HeadPromptOptions): HeadPromptBundle => ({
  systemPrompt: HEAD_SYSTEM_PROMPT,
  userPrompt: buildHeadPrompt(params),
});
