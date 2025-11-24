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
    'Wrap every BUSINESS DATA value with paired XML-style tags: `<name>value</name>`.',
    'Do NOT remove, add, or change any other characters; only insert the tags around variable values.',
    'If a variable appears multiple times, tag each occurrence. Choose clear, lowercase names; prefer user hints when provided.',
    'Return ONLY JSON in this form:',
    '{',
    '  "tagged": "the original log line with <name>...</name> markup"',
    '}',
    '',
    'Example (do not reuse literal values):',
    'Raw: [Dec 04 04:47:44 2005] Library-AP path=/tmp/a.log',
    'Tagged: [<ts>Dec 04 04:47:44 2005</ts>] <ap_name>Library-AP</ap_name> path=<path>/tmp/a.log</path>',
    'Return ONLY JSON in this form:',
    '{',
    '  "tagged": "..."',
    '}',
    '',
    'Log line:',
    logLine,
  ].join('\n');
};
