/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface ParsingPromptOptions {
  logLine: string;
  failedTemplate?: string;
  failedRendered?: string;
}

export const PARSING_SYSTEM_PROMPT =
  `You are a senior log template engineer learning template for a log line.`;

export const buildParsingPrompt = ({
  logLine,
  failedTemplate,
  failedRendered,
}: ParsingPromptOptions): string => {
  const parts = [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    `Task:
- Mark all BUSINESS DATA (variables) directly in the raw log line WITHOUT changing any other characters.
- Wrap each variable span with the OSC placeholder that contains the ORIGINAL raw value: \\u001b]9;<value>\\u0007.`,
    `Output format:
Return ONLY the following JSON object (no extra keys, no comments, no trailing text):
{
  "template": "<raw log with placeholders inserted>"
}`,
    `Log line:
${logLine}`,
    failedTemplate && failedRendered
      ? `Previous incorrect template: ${failedTemplate}
When interpreting placeholders as their embedded values, it reconstructed to: ${failedRendered}
Fix the annotation so the reconstructed line matches the raw log exactly.`
      : '',
  ].filter(Boolean);

  return parts.join('\n\n');
};
