/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface ValidationPromptOptions {
  pattern: string;
  variables: string[];
  sample: string;
  captures: Record<string, string>;
}

export const VALIDATION_SYSTEM_PROMPT = `You are reviewing whether a proposed regex template treats STRUCTURE vs BUSINESS DATA correctly. Focus on semantic consistency with the shared knowledge.`;

export const VALIDATION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: {
      type: 'array',
      items: { type: 'string' },
    },
    advice: { type: 'string' },
  },
};

export const buildValidationPrompt = ({
  pattern,
  variables,
  sample,
  captures,
}: ValidationPromptOptions): string => {
  const formattedCaptures = Object.entries(captures)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
  const variableList = variables.length > 0 ? variables.join(', ') : '(none)';

  return [
    `Shared knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    'Review whether the regex below marks STRUCTURE vs BUSINESS DATA correctly and strictly follow the requirement in the shared knowledge.',
    'If any BUSINESS DATA is misclassified or any rules are violated, explain the issue and advice.',
    '',
    `Regex template:\n${pattern}`,
    `Declared variables: ${variableList}`,
    `Sample log line:\n${sample}`,
    'Captured BUSINESS DATA example:',
    formattedCaptures || '- (no captures)',
    '',
    'Return ONLY JSON in this form:',
    '{',
    '  "verdict": "pass" | "fail",',
    '  "issue": "very brief description of issue",',
    '  "advice": "very brief advice"',
    '}',
  ].join('\n');
};
