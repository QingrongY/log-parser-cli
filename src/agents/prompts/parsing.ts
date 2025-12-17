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
Follow the shared background knowledge strictly.
Output must be valid JSON only (no markdown, no extra text).`;

export const buildParsingPrompt = ({
  logLine,
  variableHints,
}: ParsingPromptOptions): string => {
  const hints =
    variableHints?.length
      ? `User preferences for variable naming (use when applicable): ${variableHints.join(', ')}`
      : '';

  const parts = [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    hints && `\n${hints}\n`,
    `Task:
- Mark all BUSINESS DATA (variables) directly in the raw log line WITHOUT changing any other characters.
- Replace each variable span with the placeholder \\u001b]9;var=<name>\\u0007.
- Do NOT include the variable value inline in the template.
- Provide all original values (verbatim) in a variables map.
- If the same type of BUSINESS DATA appears multiple times, use indexed names (e.g., ip1, ip2). Prefer clear, lowercase names; prefer user hints when provided.`,
    `Output format:
Return ONLY the following JSON object (no extra keys, no comments, no trailing text):
{
  "template": "<raw log with placeholders inserted>",
  "variables": {
    "<name1>": "<value1>",
    "<name2>": "<value2>"
  }
}`,
    `Example (do not reuse literal values):
Raw: [Dec 04 04:47:44 2005] Library-AP path=/tmp/a.log
JSON:
{
  "template": "[\\u001b]9;var=timestamp\\u0007] Library-AP path=\\u001b]9;var=path\\u0007",
  "variables": { "timestamp": "Dec 04 04:47:44 2005", "path": "/tmp/a.log" }
}`,
    `Log line:
${logLine}`,
  ].filter(Boolean);

  return parts.join('\n\n');
};
