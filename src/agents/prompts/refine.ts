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

Shared background knowledge:
${COMMON_LOG_PARSER_KNOWLEDGE}

Task:
- Decide whether to REFINE the candidate or ADOPT it as-is.
- REFINE_CANDIDATE: The candidate template is too generic and marks STRUCTURE as BUSINESS DATA. Make it strictly MORE SPECIFIC.
- ADOPT_CANDIDATE: The candidate template is better and accurately captures previously overlooked BUSINESS DATA. Return the candidate EXACTLY as provided.

Output rules if refine candidate:
- Mark BUSINESS DATA spans inline with placeholders containing the ORIGINAL raw value: ⟪<value>⟫.
- Do NOT invent variable names or abstractions; the placeholder content must stay identical to the raw value.

Output JSON only (no markdown, no extra text):
{
  "action": "refine_candidate" | "adopt_candidate",
  "template": "<template>",
  "explain": "<brief reason>"
}
`.trim();

export const REFINE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['action', 'template', 'explain'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['refine_candidate', 'adopt_candidate'] },
    template: { type: 'string', minLength: 1 },
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

  return [
    'Candidate template:',
    candidate.placeholderTemplate ?? '(no template)',
    'Candidate sample:',
    candidateSample,
    '',
    'Existing template:',
    conflicting.placeholderTemplate ?? '(no template)',
    'Existing sample:',
    conflictingSample,
  ].join('\n');
};
