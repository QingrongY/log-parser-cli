/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regex builder utilities for constructing regex patterns from log templates.
 * Extracted from parsing-agent to make it reusable across the codebase.
 */

import { extractVariablesFromTemplate } from './template-variable-extractor.js';
import type { ExtractedTemplateVariables } from './template-variable-extractor.js';

export { extractVariablesFromTemplate } from './template-variable-extractor.js';

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

export interface BuiltRegex {
  pattern: string;
  variables: string[];
  values: Record<string, string>;
  reconstructed: string;
}

/**
 * Builds a regex pattern from an annotated template.
 *
 * @param template - Template string with OSC placeholders that contain raw values
 * @param sample - Optional sample to validate reconstruction against
 * @returns Object containing the regex pattern, capture names, and extracted values
 * @throws Error if template is invalid or reconstruction doesn't match sample
 */
export const buildRegexFromTemplate = (
  template: string,
  sample?: string,
): BuiltRegex => {
  const parsed: ExtractedTemplateVariables = extractVariablesFromTemplate(template, sample);
  const variables = parsed.order;
  const parts: string[] = [];
  let varIndex = 0;

  if (parsed.segments.length === 0) {
    throw new Error('Template did not produce any annotated segments.');
  }

  for (const segment of parsed.segments) {
    if (segment.kind === 'text') {
      parts.push(escapeRegex(segment.value));
      continue;
    }
    const name = variables[varIndex++] ?? `v${varIndex}`;
    const fragment = inferRegexForValue(segment.value);
    parts.push(`(?<${name}>${fragment})`);
  }

  return {
    pattern: parts.join(''),
    variables,
    values: parsed.variables,
    reconstructed: parsed.reconstructed,
  };
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
