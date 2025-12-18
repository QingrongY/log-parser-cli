/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified console logger with structured, multiline output.
 * Each non-empty field is printed on its own line for readability.
 */
export const logConsole = (
  level: 'info' | 'warn' | 'error',
  label: string,
  fields: Array<[string, string | number | undefined | null]>,
): void => {
  const filtered = fields.filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  ) as Array<[string, string | number]>;
  const width = filtered.reduce((max, [key]) => Math.max(max, key.length), 0);
  const lines: string[] = [`[log-parser] ${label}:`];
  for (const [key, value] of filtered) {
    lines.push(`  ${key.padEnd(width)} = ${value}`);
  }
  const output = lines.join('\n');
  if (level === 'warn') {
    console.warn(output);
  } else if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
};

/**
 * Highlights OSC placeholder markers ( \u001b]9;value\u0007 ) with ANSI color.
 */
export const colorizePlaceholders = (text?: string): string | undefined =>
  typeof text === 'string'
    ? text.replace(/\u001b]9;([^\u0007]+)\u0007/g, (_m, v) => `\x1b[36m${v}\x1b[0m`)
    : undefined;

/**
 * Produces a per-character diff highlighting differences between two strings.
 * Matches are left unstyled; differences are green (expected) and red (actual).
 */
export const diffStrings = (
  expected?: string,
  actual?: string,
): { expected?: string; actual?: string } => {
  if (expected === undefined || actual === undefined) {
    return { expected, actual };
  }
  const maxLen = Math.max(expected.length, actual.length);
  let expOut = '';
  let actOut = '';
  for (let i = 0; i < maxLen; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e === a) {
      if (e !== undefined) expOut += e;
      if (a !== undefined) actOut += a;
      continue;
    }
    if (e !== undefined) expOut += `\x1b[32m${e}\x1b[0m`;
    if (a !== undefined) actOut += `\x1b[31m${a}\x1b[0m`;
  }
  return { expected: expOut, actual: actOut };
};
