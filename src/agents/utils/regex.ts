/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RegexMatchResult {
  matched: boolean;
  variables: Record<string, string>;
  error?: string;
}

export const matchEntireLine = (pattern: string, line: string): RegexMatchResult => {
  try {
    const base = new RegExp(pattern);
    const normalized = new RegExp(base.source, base.flags.replace(/g/g, ''));
    normalized.lastIndex = 0;
    const match = normalized.exec(line);
    if (!match) {
      return { matched: false, variables: {} };
    }
    if (match[0] !== line) {
      return {
        matched: false,
        variables: {},
        error: 'Pattern did not match the entire line. Add ^ and $ anchors or adjust STRUCTURE.',
      };
    }
    return {
      matched: true,
      variables: { ...(match.groups ?? {}) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      matched: false,
      variables: {},
      error: message,
    };
  }
};

export const normalizeRegexPattern = (pattern: string): string => {
  let normalized = pattern.trim();
  if (!normalized.startsWith('^')) {
    normalized = `^${normalized}`;
  }
  if (!normalized.endsWith('$')) {
    normalized = `${normalized}$`;
  }
  return normalized;
};
