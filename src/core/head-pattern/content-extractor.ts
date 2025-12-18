/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition, HeadPatternDefinition } from '../../agents/index.js';
import type { RegexLogEntry } from '../regex-worker-pool.js';
import { extractContentWithHead } from '../head-pattern.js';

export interface HeadRuntime {
  regex: RegExp;
  head: HeadPatternDefinition;
}

export interface ContentExtractionResult {
  text?: string;
  error?: string;
}

/**
 * Unified content extraction logic for head patterns.
 * Handles both pre-extracted content (from RegexLogEntry) and on-demand extraction.
 */
export class HeadContentExtractor {
  /**
   * Determines the appropriate text to use for template matching/validation.
   * Returns content if template is content-only, otherwise returns raw log.
   *
   * @param template - The template being applied
   * @param entry - The log entry containing raw and optionally pre-extracted content
   * @param headPattern - Optional head pattern definition
   * @param headRuntime - Optional pre-compiled head runtime (regex + pattern)
   * @returns The target text to match against, or an error if extraction fails
   */
  getTextForTemplate(
    template: LogTemplateDefinition,
    entry: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
    headRuntime?: HeadRuntime,
  ): ContentExtractionResult {
    const contentOnly = Boolean(template.metadata?.['contentOnly']);

    if (!contentOnly) {
      return { text: entry.raw };
    }

    if (!headPattern?.pattern && !headRuntime) {
      return { text: undefined, error: 'Content-only template requires head pattern' };
    }

    if (entry.content !== undefined && entry.headMatched) {
      return { text: entry.content?.trimStart() };
    }

    if (headRuntime) {
      const extracted = extractContentWithHead(entry.raw, headRuntime.head, headRuntime.regex);
      if (!extracted.matched) {
        return { text: undefined, error: 'Head pattern did not match log entry' };
      }
      return { text: extracted.content?.trimStart() };
    }

    if (headPattern) {
      try {
        const regex = new RegExp(headPattern.pattern);
        const extracted = extractContentWithHead(entry.raw, headPattern, regex);
        if (!extracted.matched) {
          return { text: undefined, error: 'Head pattern did not match log entry' };
        }
        return { text: extracted.content?.trimStart() };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: undefined, error: `Head pattern compilation failed: ${message}` };
      }
    }

    return { text: undefined, error: 'Head extraction missing content' };
  }

  /**
   * Builds a compiled head runtime from a head pattern definition.
   * Returns undefined if pattern is invalid or compilation fails.
   */
  buildHeadRuntime(head?: HeadPatternDefinition): HeadRuntime | undefined {
    if (!head?.pattern) {
      return undefined;
    }
    try {
      const regex = new RegExp(head.pattern);
      return { regex, head };
    } catch {
      return undefined;
    }
  }
}
