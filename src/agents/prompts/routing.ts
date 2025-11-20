/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface RoutingPromptOptions {
  samples: string[];
}

export const ROUTING_SYSTEM_PROMPT =
  `You are an engineer who is very familiar with various types of log data.
  Focus on identifying what type of provided logs are.`;

export const ROUTING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', minLength: 1 },
    note: { type: 'string' },
  },
};

export const buildRoutingPrompt = ({ samples }: RoutingPromptOptions): string => {
  const joinedSamples =
    samples.length > 0 ? samples.map((line, index) => `${index + 1}. ${line}`).join('\n') : '(no samples)';
  return [
    'You are given some raw log lines as example.',
    'Infer the most likely log provider/vendor and explain briefly the evidence.',
    'Example: Android, Aruba, HPC, or the provider/vendor you identified',
    'If the type is uncertain or appears to be a custom format, set it as "custom".',
    'Return ONLY JSON in this form:',
    '{',
    '  "type": "…",',
    '  "evidence": "…"',
    '}',
    '',
    'Sample logs:',
    joinedSamples,
  ].join('\n');
};
