/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition } from '../types.js';
import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface RefinePromptOptions {
  candidate: LogTemplateDefinition;
  candidateSamples: string[];
  conflicting: LogTemplateDefinition;
  conflictingSamples: string[];
}

export const REFINE_SYSTEM_PROMPT = `
You resolve conflicts between a candidate log template and an existing template.
A conflict means the candidate matches one or more samples currently attributed to the existing template.

Shared background knowledge (follow strictly):
${COMMON_LOG_PARSER_KNOWLEDGE}

Task:
- Decide whether to REFINE the candidate or ADOPT it as-is.
- REFINE_CANDIDATE: The candidate is too generic or marks STRUCTURE as BUSINESS DATA. Make it strictly MORE SPECIFIC.
- ADOPT_CANDIDATE: The existing template is too strict and hard-codes BUSINESS DATA. Return the candidate EXACTLY as provided.

Output rules:
- Use \\u001b]9;var=<name>\\u0007 for every BUSINESS DATA span.
- Every placeholder that appears in your returned template MUST have a value in "variables" with the same name.
- Do NOT invent extra variable names; after substitution the line must exactly reconstruct the raw log sample.
- Index repeated types (ip1, ip2, ...); prefer clear, lowercase names; prefer user hints when provided.

Output JSON only (no markdown, no extra text):
{
  "action": "refine_candidate" | "adopt_candidate",
  "template": "<template>",
  "variables": { "<name>": "<value>" },
  "explain": "<brief reason>"
}
`.trim();

export const REFINE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['action', 'template', 'variables', 'explain'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['refine_candidate', 'adopt_candidate'] },
    template: { type: 'string', minLength: 1 },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    explain: { type: 'string', minLength: 1 },
  },
};

export const buildRefinePrompt = ({
  candidate,
  candidateSamples,
  conflicting,
  conflictingSamples,
}: RefinePromptOptions): string => {
  const candidateSample = candidateSamples[0] ?? '(no sample)';
  const conflictingSample = conflictingSamples[0] ?? '(no sample)';

  const candidateVars = JSON.stringify(candidate.placeholderVariables ?? {});
  const conflictingVars = JSON.stringify(conflicting.placeholderVariables ?? {});

  return [
    'Candidate variables:',
    candidateVars,
    'Candidate sample:',
    candidateSample,
    '',
    'Existing (conflicting) variables:',
    conflictingVars,
    'Existing sample:',
    conflictingSample,
  ].join('\n');
};
