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
    'Your task is to mark BUSINESS DATA (variables) directly in the raw log without changing any other text.',
    'Use control-sequence markers for each variable: start = `\\u001b]9;var=<name>\\u0007`, end = `\\u001b]9;end\\u0007`.',
    'Example: `\\u001b]9;var=user\\u0007alice\\u001b]9;end\\u0007` wraps the value "alice" as variable "user".',
    'Do NOT remove, add, or change any other characters; only insert these markers around variable values.',
    'If a variable appears multiple times, tag each occurrence. Choose clear, lowercase names; prefer user hints when provided.',
    'Return ONLY JSON in this form:',
    '{',
    '  "tagged": "the original log line with control-sequence markup"',
    '}',
    '',
    'Example (do not reuse literal values):',
    'Raw: [Dec 04 04:47:44 2005] Library-AP path=/tmp/a.log',
    'Tagged: [\\u001b]9;var=ts\\u0007Dec 04 04:47:44 2005\\u001b]9;end\\u0007] Library-AP path=\\u001b]9;var=path\\u0007/tmp/a.log\\u001b]9;end\\u0007',
    'Return ONLY JSON in this form:',
    '{',
    '  "tagged": "..."',
    '}',
    '',
    'Log line:',
    logLine,
  ].join('\n');
};
