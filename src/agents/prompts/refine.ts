/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition } from '../types.js';

interface RefinePromptOptions {
  candidate: LogTemplateDefinition;
  candidateSamples: string[];
  conflicting: LogTemplateDefinition;
  conflictingSamples: string[];
}

export const REFINE_SYSTEM_PROMPT = `
You resolve conflicts between a candidate log template and an existing template.

A conflict means the candidate matches one or more samples currently attributed to the existing template.

Your task:
- Decide whether to REFINE the candidate or ADOPT it as-is.

Rules:
- REFINE_CANDIDATE:
  - The candidate is too generic or marks STRUCTURE as BUSINESS DATA.
  - You must make the candidate strictly MORE SPECIFIC (only tighten boundaries).

- ADOPT_CANDIDATE:
  - The existing template is too strict and hard-codes obvious BUSINESS DATA.
  - Return the candidate EXACTLY as provided (no changes).

Placeholders: \\u001b]9;var=<name>\\u0007

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
    'Candidate template:',
    candidate.placeholderTemplate,
    'Candidate variables:',
    candidateVars,
    'Candidate sample:',
    candidateSample,
    '',
    'Existing (conflicting) template:',
    conflicting.placeholderTemplate,
    'Existing variables:',
    conflictingVars,
    'Existing sample:',
    conflictingSample,
  ].join('\n');
};
