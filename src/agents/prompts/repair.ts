/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface RepairPromptOptions {
  logLine?: string;
  pattern: string;
  variables: string[];
  diagnostics: string[];
}

export const REPAIR_SYSTEM_PROMPT =
  `You are assisting another agent by repairing a failing log template.
  Make the regex match the line while honoring the shared background knowledge.`;

export const buildRepairPrompt = ({ logLine, pattern, variables, diagnostics }: RepairPromptOptions): string => {
  const logSection = logLine ? `Log line:\n${logLine}\n` : 'Log line: (not provided)\n';
  const diagnosticsList =
    diagnostics.length > 0 ? diagnostics.map((entry) => `- ${entry}`).join('\n') : '- No diagnostics provided';
  const variableList = variables.length > 0 ? variables.join(', ') : '(none)';

  return [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    'Your task is to consider why the issue happen and what should be changed.' +
    'Then, fix the template so it matches the entire log line and captures BUSINESS DATA correctly.',
    'Also, provide a list of BUSINESS DATA captured by your template, including the names and corresponding values in the example log lines.',

    logSection.trimEnd(),
    `Current template pattern:\n${pattern}`,
    `Declared variables: ${variableList}`,
    `Diagnostics:\n${diagnosticsList}`,
    'Return ONLY JSON in this form:',
    '{',
    '  "pattern": "...",',
    '  "BUSINESS DATA": {',
    '    "name1": "value1",',
    '    "name2": "value2",',
    '    ...',
    // '  "note": "Explain what changed and why."',
    '}',
  ].join('\n');
};
