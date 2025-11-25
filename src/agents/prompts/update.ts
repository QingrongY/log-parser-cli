/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';
import type { LogTemplateDefinition } from '../types.js';

interface UpdatePromptOptions {
  candidate: LogTemplateDefinition;
  candidateSamples: string[];
  conflicts: Array<{ id?: string; template: string; variables: Record<string, string>; samples: string[] }>;
}

export const UPDATE_SYSTEM_PROMPT =
  `You are addressing a conflict that a template matches logs that belong to other templates.
   You need to make a decision to address this issue.`;

export const UPDATE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['action', 'template', 'variables'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['Modify candidate', 'Modify existing'] },
    template: { type: 'string', minLength: 1 },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    explain: { type: 'string' },
  },
};

export const buildUpdatePrompt = ({
  candidate,
  candidateSamples,
  conflicts,
}: UpdatePromptOptions): string => {
  const candidateLogSection =
    candidateSamples.length > 0 ? `- ${candidateSamples[0]}` : '- (no candidate sample provided)';

  const conflictSection =
    conflicts.length > 0
      ? conflicts
          .map((entry, index) => {
            const conflictSample =
              entry.samples.length > 0 ? `      • ${entry.samples[0]}` : '      • (no sample provided)';
            const varList = Object.entries(entry.variables ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            return [
              `${index + 1}. Template ID: ${entry.id ?? 'unknown'}`,
              `   Template: ${entry.template}`,
              `   Variables: ${varList || '(none)'}`,
              '   Sample log:',
              conflictSample,
            ].join('\n');
          })
          .join('\n\n')
      : '(none)';

  return [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    'A new candidate template (in placeholder form) matches logs belonging to existing templates.',
    'Strictly follow the Shared Background Knowledge and decide whether to modify the candidate or the existing templates to ensure the library stays mutually exclusive.',
    '1. Modify candidate, in case of:',
    '   The candidate template is too generic and incorrectly matches parts outside the BUSINESS VARIABLES.',
    '   More constraints (specific values/types/lengths) should be introduced into the candidate template.',
    '2. Modify existing, in case of:',
    '   The existing templates are too strict and incorrectly treat BUSINESS VARIABLES as constants.',
    '   The candidate template should be adopted and replace them.',
    'Also, provide a list of BUSINESS DATA captured by your template, including the names and corresponding values in the example log lines.',
    'Return ONLY JSON in this form:',
    '{',
    '  "action": "Modify candidate" | "Modify existing",',
    '  "template": "log with ESC]9;var=<name> BEL placeholders inserted instead of variable values",',
    '  "variables": {',
    '    "name1": "value1",',
    '    "name2": "value2"',
    '  },',
    '  "BUSINESS DATA": { "optional": "keep empty or copy variables" }',
    '}',
    `Candidate template:\n${candidate.placeholderTemplate}`,
    'Candidate sample log:',
    candidateLogSection,
    'Conflicting templates and their sample logs:',
    conflictSection,
  ].join('\n');
};
