/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const HEAD_SYSTEM_PROMPT = [
  'Derive a single regex that matches all provided log samples to distinguish between the head and content.',
  '- The "head" is the longest stable format prefix and should be matched explicitly, not captured.',
  '- The "content" is the remainder of the log line outside the head. Capture it using a named capture group (?<content>...).',
  '- Prefer using a non-greedy pattern that stops at a known stable delimiter (e.g., .*? + delimiter).',
  '- Output JSON only: {"pattern": "<JavaScript regex pattern>"}',
].join('\n');

export const HEAD_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['pattern'],
  additionalProperties: false,
  properties: {
    pattern: { type: 'string' },
  },
};

export const buildHeadPrompt = (params: { samples: string[]; previousPattern?: string }): string => {
  const lines = params.samples
    .filter((line) => line && line.trim().length > 0)
    .map((line) => line.trim());

  const numbered = lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n');
  const previous = params.previousPattern
    ? ['Previous pattern (FAILED to match all samples). Use it only as a starting point; revise or replace as needed:', params.previousPattern, '']
    : [];

  return [
    ...previous,
    'Samples:',
    numbered,
  ].join('\n');
};
