/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HeadPatternDefinition } from '../../agents/index.js';

export interface HeadExtractionResult {
  matched: boolean;
  content?: string;
}

export const extractContentWithHead = (
  raw: string,
  headPattern?: HeadPatternDefinition,
  precomputed?: RegExp,
): HeadExtractionResult => {
  if (!headPattern?.pattern) {
    return { matched: false, content: undefined };
  }
  let regex = precomputed;
  if (!regex) {
    try {
      regex = new RegExp(headPattern.pattern);
    } catch {
      return { matched: false, content: undefined };
    }
  }
  const match = regex.exec(raw);
  if (!match) {
    return { matched: false, content: undefined };
  }
  const content = match.groups?.['content'] ?? match[1];
  return { matched: true, content };
};
