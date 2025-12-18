/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regex builder utilities for constructing regex patterns from log templates.
 * Extracted from parsing-agent to make it reusable across the codebase.
 */

type TaggedSegment =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string; value: string };

const ESC = '\u001b';
const BEL = '\u0007';
const START_PREFIX = `${ESC}]9;var=`;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

/**
 * Builds a regex pattern from a template with variable placeholders.
 *
 * @param template - Template string with OSC escape sequences marking variables
 * @param values - Map of variable names to their actual values
 * @param sample - Optional sample to validate reconstruction against
 * @returns Object containing the regex pattern and list of variable names
 * @throws Error if template is invalid or reconstruction doesn't match sample
 */
export const buildRegexFromTemplate = (
  template: string,
  values: Record<string, string>,
  sample?: string,
): { pattern: string; variables: string[] } => {
  const segments = parseTemplateSegments(template, values);
  if (segments.length === 0) {
    throw new Error('LLM did not produce any placeholders.');
  }

  const variables: string[] = [];
  const nameCounts = new Map<string, number>();
  const parts: string[] = [];
  const reconstructed: string[] = [];

  for (const segment of segments) {
    if (segment.kind === 'text') {
      parts.push(escapeRegex(segment.value));
      reconstructed.push(segment.value);
      continue;
    }
    const baseName = sanitizeVariableName(segment.name);
    const count = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, count);
    const finalName = count === 1 ? baseName : `${baseName}${count}`;
    variables.push(finalName);
    const fragment = inferRegexForValue(segment.value);
    parts.push(`(?<${finalName}>${fragment})`);
    reconstructed.push(segment.value);
  }

  if (sample !== undefined) {
    const joined = reconstructed.join('');
    if (joined !== sample) {
      throw new Error('Reconstructed line does not match the raw sample.');
    }
  }

  return { pattern: parts.join(''), variables };
};

/**
 * Parses a template string into segments of text and variables.
 *
 * @param template - Template with OSC escape sequences
 * @param values - Variable name to value mapping
 * @returns Array of parsed segments
 * @throws Error if a placeholder references an undefined variable
 */
const parseTemplateSegments = (
  template: string,
  values: Record<string, string>,
): TaggedSegment[] => {
  const segments: TaggedSegment[] = [];
  let cursor = 0;

  const pushText = (end: number): void => {
    if (end > cursor) {
      segments.push({ kind: 'text', value: template.slice(cursor, end) });
    }
  };

  while (cursor < template.length) {
    const startIdx = template.indexOf(START_PREFIX, cursor);
    if (startIdx === -1) {
      pushText(template.length);
      break;
    }

    pushText(startIdx);
    const nameStart = startIdx + START_PREFIX.length;
    const nameEnd = template.indexOf(BEL, nameStart);
    if (nameEnd === -1) {
      // No terminator; treat the ESC as literal.
      segments.push({ kind: 'text', value: template.slice(startIdx, startIdx + 1) });
      cursor = startIdx + 1;
      continue;
    }

    const name = template.slice(nameStart, nameEnd);
    if (!name) {
      segments.push({ kind: 'text', value: template.slice(startIdx, nameEnd + 1) });
      cursor = nameEnd + 1;
      continue;
    }

    const value = values[name];
    if (value === undefined) {
      throw new Error(`LLM template placeholder "${name}" missing value in variables map.`);
    }

    segments.push({ kind: 'var', name, value });
    cursor = nameEnd + 1;
  }

  return segments;
};

/**
 * Escapes special regex characters in text.
 * Also escapes control characters as hex sequences.
 *
 * @param text - Text to escape
 * @returns Escaped text safe for use in regex
 */
const escapeRegex = (text: string): string => {
  let escaped = text.replace(REGEX_SPECIAL, '\\$&');
  escaped = escaped.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\x${hex}`;
  });
  return escaped;
};

/**
 * Sanitizes a variable name to be safe for use in regex named groups.
 *
 * @param name - Raw variable name
 * @returns Sanitized name (lowercase, alphanumeric + underscore)
 * @throws Error if name is empty or invalid
 */
const sanitizeVariableName = (name: string): string => {
  const cleaned = name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
  if (!cleaned) {
    throw new Error('Invalid variable name encountered in tags.');
  }
  return cleaned;
};

/**
 * Map of special characters to their regex escape sequences.
 */
const SPECIAL_SYMBOL_MAP: Record<string, string> = {
  ' ': '\\s+',
  '\t': '\\t',
  '\r': '\\r',
  '\n': '\\n',
  '!': '\\!',
  '"': '\\"',
  '#': '\\#',
  '$': '\\$',
  '%': '\\%',
  '&': '\\&',
  "'": "\\'",
  '(': '\\(',
  ')': '\\)',
  '*': '\\*',
  '+': '\\+',
  ',': '\\,',
  '-': '\\-',
  '.': '\\.',
  '/': '\\/',
  ':': '\\:',
  ';': '\\;',
  '<': '\\<',
  '=': '\\=',
  '>': '\\>',
  '?': '\\?',
  '@': '\\@',
  '[': '\\[',
  '\\': '\\\\',
  ']': '\\]',
  '^': '\\^',
  '_': '_',
  '`': '\\`',
  '{': '\\{',
  '|': '\\|',
  '}': '\\}',
  '~': '\\~',
};

/**
 * Infers a regex pattern from a variable's value.
 * Uses character class patterns for alphanumeric runs and escapes special symbols.
 *
 * @param value - The variable's value
 * @returns Regex pattern that would match this value
 */
const inferRegexForValue = (value: string): string => {
  if (value.length === 0) {
    return '[^\\r\\n]*';
  }

  const parts: string[] = [];
  let inRun = false;

  const flushRun = (): void => {
    if (inRun) {
      parts.push('[A-Za-z0-9_/-]+');
      inRun = false;
    }
  };

  for (const ch of value) {
    if (/[A-Za-z0-9_/-]/.test(ch)) {
      if (!inRun) {
        flushRun();
        inRun = true;
      }
      continue;
    }

    // Special symbol
    flushRun();
    parts.push(escapeSpecialChar(ch));
  }

  flushRun();
  return parts.join('');
};

/**
 * Escapes a special character for use in regex.
 *
 * @param ch - Character to escape
 * @returns Escaped character sequence
 */
const escapeSpecialChar = (ch: string): string => {
  if (SPECIAL_SYMBOL_MAP[ch] !== undefined) {
    return SPECIAL_SYMBOL_MAP[ch];
  }
  // Fallback to hex escape to keep regex safe for unexpected symbols.
  const code = ch.codePointAt(0);
  if (code === undefined) {
    return '';
  }
  if (code <= 0xff) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return `\\u${code.toString(16).padStart(4, '0')}`;
};
