/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from '../knowledge.js';

interface RepairPromptOptions {
  logLine?: string;
  template: string;
  variables: Record<string, string>;
  diagnostics: string[];
}

export const REPAIR_SYSTEM_PROMPT =
  `You are assisting another agent by repairing a failing log template.
  Use placeholders and variable map, not raw regex. Keep the log text unchanged except for inserting placeholders.`;

export const buildRepairPrompt = ({ logLine, template, variables, diagnostics }: RepairPromptOptions): string => {
  const logSection = logLine ? `Log line:\n${logLine}\n` : 'Log line: (not provided)\n';
  const diagnosticsList =
    diagnostics.length > 0 ? diagnostics.map((entry) => `- ${entry}`).join('\n') : '- No diagnostics provided';
  const variableList =
    Object.keys(variables).length > 0
      ? Object.entries(variables)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : '(none)';

  return [
    `Shared background knowledge:\n${COMMON_LOG_PARSER_KNOWLEDGE}`,
    'Your task is to consider why the issue happened and what should be changed.' +
    'Then, fix the template (using placeholders) so it matches the entire log line and captures BUSINESS DATA correctly.',
    'Placeholders are in the form ESC]9;slot=<name>BEL (\\u001b]9;slot=<name>\\u0007).',
    'Do NOT output regex. Keep the log text unchanged except for placeholders.',

    logSection.trimEnd(),
    `Current template with placeholders:\n${template}`,
    `Declared variables (name=value): ${variableList}`,
    `Diagnostics:\n${diagnosticsList}`,
    'Return ONLY JSON in this form:',
    '{',
    '  "template": "log with ESC]9;slot=<name> BEL placeholders instead of variable values",',
    '  "variables": {',
    '    "name1": "value1",',
    '    "name2": "value2"',
    '  }',
    '  // optional: "note": "Explain what changed and why."',
    '}',
  ].join('\n');
};
