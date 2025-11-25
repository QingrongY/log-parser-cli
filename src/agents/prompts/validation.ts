/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface ValidationPromptOptions {
  sample: string;
  variables: Record<string, string>;
}

export const VALIDATION_SYSTEM_PROMPT = `You are reviewing whether extracted VARIABLES look like BUSINESS DATA vs STRUCTURE. Focus on semantic consistency with the shared knowledge.`;

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

export const buildValidationPrompt = ({ sample, variables }: ValidationPromptOptions): string => {
  const formatted = Object.entries(variables)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');

  return [
    `Shared knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    'Given the raw log sample and extracted variables, decide if any variable is actually STRUCTURE (fixed text) or mixes STRUCTURE with BUSINESS DATA. Treat sentences/constant fragments as STRUCTURE.',
    '',
    `Raw sample:\n${sample}`,
    '',
    'Variables:',
    formatted || '- (none)',
    '',
    'Return ONLY JSON in this form:',
    '{',
    '  "verdict": "pass" | "fail",',
    '  "issues": ["very brief issue 1", "very brief issue 2"],',
    '  "advice": "very brief advice"',
    '}',
  ].join('\n');
};
