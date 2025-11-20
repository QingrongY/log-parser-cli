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
    'Your task is to analyze the following log line and generate a template in regex format.',
    'The template should use named capture groups for BUSINESS DATA (variables) in JS style. For example, `(?<user>[\w.-]+)`.',
    'All other text should be treated as STRUCTURE (constants) and kept literal.',
    'Also, provide a list of BUSINESS DATA captured by your template, including the names and corresponding values in the example log lines.',
    'Return ONLY JSON in this form:',
    '{',
    '  "pattern": "...",',
    '  "BUSINESS DATA": {',
    '    "name1": "value1",',
    '    "name2": "value2",',
    '    ...',
    '  }',
    '}',
    '',
    'Log line:',
    logLine,
  ].join('\n');
};
