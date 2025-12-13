/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface ParsingPromptOptions {
  logLine: string;
  variableHints: string[];
}

export const PARSING_SYSTEM_PROMPT =
  `You are a senior log template engineer learning templates line-by-line. 
  Focus on accurately separating STRUCTURE (constants) and BUSINESS DATA (variables) per the shared background knowledge.`;

export const buildParsingPrompt = ({ logLine, variableHints }: ParsingPromptOptions): string => {
  const hintsSection =
    variableHints.length > 0
      ? `Consider the following preferences provided by users: ${variableHints}`
      : '';

  return [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    `${hintsSection}.`,
    'Your task is to mark all BUSINESS DATA (variables) directly in the raw log without changing any other text.',
    'Use control-sequence placeholders for each variable: insert `\\u001b]9;var=<name>\\u0007` where the variable value should go. Do NOT include the value inline.',
    'Provide the marked actual values in a variables map as their literal contents.',
    'Do NOT remove, add, or change any other characters; only replace variable spans with the placeholder marker.',
    'If a variable appears multiple times, insert the placeholder each time. Choose clear, lowercase names; prefer user hints when provided.',
    'Return ONLY JSON in this form, which provides the actual values in a variables map as their literal contents.\',\n:',
    '{',
    '  "template": "raw log with placeholders (\\u001b]9;var=name\\u0007) inserted instead of variable values",',
    '  "variables": {',
    '    "name1": "value1",',
    '    "name2": "value2"',
    '  }',
    '}',
    '',
    'Example (do not reuse literal values):',
    'Raw: [Dec 04 04:47:44 2005] Library-AP path=/tmp/a.log',
    'Template: [\\u001b]9;var=timestamp\\u0007] Library-AP path=\\u001b]9;var=path\\u0007',
    'Variables: { "timestamp": "Dec 04 04:47:44 2005", "path": "/tmp/a.log" }',
    '',
    'Log line:',
    logLine,
  ].join('\n');
};
