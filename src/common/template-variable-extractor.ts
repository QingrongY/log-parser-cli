/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fixDuplicatedVariables } from './template-duplication-fixer.js';

const START_PREFIX = '⟪';
const END_PREFIX = '⟫';

/**
 * Extracts inline variable values from an annotated template.
 * The template embeds the ORIGINAL values inside double angle bracket placeholders, so this
 * function simply reads them back (and optionally verifies against the raw log).
 * Templates with no placeholders are allowed and will return an empty variable map.
 *
 * @param template - Template string with ⟪⟫ placeholders marking variables
 *                   that already contain the raw values (no variable names)
 * @param logLine - Optional raw log line to validate reconstruction against
 * @returns Ordered variables map plus parsed segments and reconstructed text
 * @throws Error if template structure is invalid or reconstruction fails
 *
 * @example
 * const template = "User ⟪john⟫ logged in at ⟪14:30⟫";
 * const logLine = "User john logged in at 14:30";
 * const { variables, order } = extractVariablesFromTemplate(template, logLine);
 * // variables = { v1: "john", v2: "14:30" }, order = ["v1", "v2"]
 */
export function extractVariablesFromTemplate(
  template: string,
  logLine?: string,
): ExtractedTemplateVariables {
  const segments = parseTemplateStructure(template);

  if (segments.length === 0) {
    throw new Error('Template contains no segments.');
  }

  const variables: Record<string, string> = {};
  const order: string[] = [];
  const reconstructed: string[] = [];
  let varIndex = 0;

  for (const segment of segments) {
    if (segment.kind === 'text') {
      reconstructed.push(segment.value);
      continue;
    }

    varIndex += 1;
    const name = `v${varIndex}`;
    order.push(name);
    variables[name] = segment.value;
    reconstructed.push(segment.value);
  }

  const reconstructedLine = reconstructed.join('');
  if (logLine !== undefined && reconstructedLine !== logLine) {
    const fixResult = fixDuplicatedVariables(template, logLine);
    if (fixResult.fixed && fixResult.fixedTemplate) {
      return extractVariablesFromTemplate(fixResult.fixedTemplate, logLine);
    }

    throw new Error(
      `Template reconstruction does not match the provided log line. Expected "${logLine}", got "${reconstructedLine}".`,
    );
  }

  return {
    variables,
    order,
    segments,
    reconstructed: reconstructedLine,
  };
}

/**
 * Parsed segment of a template.
 */
export type TemplateSegment =
  | { kind: 'text'; value: string }
  | { kind: 'var'; value: string };

export interface ExtractedTemplateVariables {
  variables: Record<string, string>;
  order: string[];
  segments: TemplateSegment[];
  reconstructed: string;
}

/**
 * Parses a template string into text and variable segments.
 *
 * @param template - Template with ⟪⟫ placeholders carrying raw values
 * @returns Array of parsed segments in order
 */
function parseTemplateStructure(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
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

    const valueStart = startIdx + START_PREFIX.length;
    const valueEnd = template.indexOf(END_PREFIX, valueStart);

    if (valueEnd === -1) {
      segments.push({ kind: 'text', value: template.slice(startIdx, startIdx + 1) });
      cursor = startIdx + 1;
      continue;
    }

    const value = template.slice(valueStart, valueEnd);
    segments.push({ kind: 'var', value });
    cursor = valueEnd + 1;
  }

  return segments;
}
