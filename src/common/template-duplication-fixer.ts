/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detects and fixes duplicated variable values in templates.
 * This is a common LLM error where it repeats variable values.
 *
 * Example:
 * - Input value: "1930319303", Expected: "19303"
 * - Input value: "10.100.20.25010.100.20.250", Expected: "10.100.20.250"
 */

const START_PREFIX = '⟪';
const END_PREFIX = '⟫';

export interface DuplicationFixResult {
  fixed: boolean;
  originalTemplate: string;
  fixedTemplate?: string;
  fixes: Array<{
    variable: string;
    originalValue: string;
    fixedValue: string;
    position: number;
  }>;
}

/**
 * Attempts to fix a template where variable values have been duplicated.
 *
 * @param template - The template with ⟪⟫ placeholders
 * @param expectedLogLine - The original log line that should be reconstructed
 * @returns Result indicating if fixes were made and the new template
 */
export function fixDuplicatedVariables(
  template: string,
  expectedLogLine: string,
): DuplicationFixResult {
  const result: DuplicationFixResult = {
    fixed: false,
    originalTemplate: template,
    fixes: [],
  };

  const variables = extractVariablesFromTemplate(template);
  if (variables.length === 0) {
    return result;
  }

  let fixedTemplate = template;
  let anyFixed = false;

  for (const varInfo of variables) {
    const fixedValue = findBestDuplicationFix(varInfo.value, expectedLogLine);
    if (fixedValue !== null && fixedValue !== varInfo.value) {
      const oldPlaceholder = `${START_PREFIX}${varInfo.value}${END_PREFIX}`;
      const newPlaceholder = `${START_PREFIX}${fixedValue}${END_PREFIX}`;
      fixedTemplate = fixedTemplate.replace(oldPlaceholder, newPlaceholder);

      result.fixes.push({
        variable: `v${varInfo.index}`,
        originalValue: varInfo.value,
        fixedValue: fixedValue,
        position: varInfo.position,
      });
      anyFixed = true;
    }
  }

  if (anyFixed) {
    result.fixed = true;
    result.fixedTemplate = fixedTemplate;
  }

  return result;
}

/**
 * Finds the best fix for a duplicated value by checking if it exists in the log line.
 *
 * @param duplicatedValue - The potentially duplicated value
 * @param logLine - The original log line
 * @returns The fixed value, or null if no fix found
 */
function findBestDuplicationFix(
  duplicatedValue: string,
  logLine: string,
): string | null {
  if (logLine.includes(duplicatedValue)) {
    return null;
  }

  const halfLength = Math.floor(duplicatedValue.length / 2);

  for (let len = halfLength; len >= 1; len--) {
    const possibleOriginal = duplicatedValue.slice(0, len);

    if (isRepeatedPattern(duplicatedValue, possibleOriginal)) {
      if (logLine.includes(possibleOriginal)) {
        return possibleOriginal;
      }
    }
  }

  const midPoint = Math.floor(duplicatedValue.length / 2);
  if (midPoint >= 3) {
    const firstHalf = duplicatedValue.slice(0, midPoint);
    const secondHalf = duplicatedValue.slice(midPoint);

    if (secondHalf.startsWith(firstHalf) || firstHalf.endsWith(secondHalf)) {
      if (logLine.includes(firstHalf)) {
        return firstHalf;
      }
      if (logLine.includes(secondHalf)) {
        return secondHalf;
      }
    }
  }

  return null;
}

/**
 * Checks if a value is a repeated pattern.
 *
 * @param value - The value to check
 * @param pattern - The pattern to look for
 * @returns True if value is pattern repeated
 */
function isRepeatedPattern(value: string, pattern: string): boolean {
  if (pattern.length === 0) return false;

  const repeatCount = Math.floor(value.length / pattern.length);
  if (repeatCount < 2) return false;

  const repeated = pattern.repeat(repeatCount);
  return value.startsWith(repeated);
}

/**
 * Escapes special regex characters.
 */
function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

interface VariableInfo {
  index: number;
  value: string;
  position: number;
}

/**
 * Extracts variable information from template.
 */
function extractVariablesFromTemplate(template: string): VariableInfo[] {
  const variables: VariableInfo[] = [];
  let cursor = 0;
  let varIndex = 0;

  while (cursor < template.length) {
    const startIdx = template.indexOf(START_PREFIX, cursor);
    if (startIdx === -1) break;

    const valueStart = startIdx + START_PREFIX.length;
    const valueEnd = template.indexOf(END_PREFIX, valueStart);
    if (valueEnd === -1) {
      cursor = startIdx + 1;
      continue;
    }

    const value = template.slice(valueStart, valueEnd);
    variables.push({
      index: ++varIndex,
      value,
      position: startIdx,
    });
    cursor = valueEnd + 1;
  }

  return variables;
}