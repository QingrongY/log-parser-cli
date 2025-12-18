/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition, HeadPatternDefinition } from '../../agents/index.js';
import type { TemplateLibrary } from '../types.js';
import type { RegexLogEntry } from '../regex-worker-pool.js';
import { buildRegexFromTemplate } from '../../common/regex-builder.js';
import { matchEntireLine } from '../../agents/utilities/regex.js';

/**
 * Detects conflicts between a candidate template and existing templates in a library.
 * A conflict occurs when a new template matches samples that were previously matched
 * by a different template.
 */
export class ConflictDetector {
  /**
   * Finds all existing templates that conflict with the candidate template.
   *
   * @param candidate - The new template to check for conflicts
   * @param library - The template library containing existing templates and matched samples
   * @param headPattern - Optional head pattern for content extraction
   * @returns Array of conflicting templates with their conflicting samples
   */
  findConflicts(
    candidate: LogTemplateDefinition,
    library: TemplateLibrary,
    headPattern?: HeadPatternDefinition,
  ): Array<{ template: LogTemplateDefinition; samples: string[] }> {
    const candidateRuntime = buildRegexFromTemplate(
      candidate.placeholderTemplate,
      candidate.placeholderVariables,
      undefined,
    );
    const conflicts = new Map<string, { template: LogTemplateDefinition; samples: string[] }>();
    const templateMap = new Map(library.templates.map((t) => [t.id ?? '', t]));

    for (const sample of library.matchedSamples) {
      if (!sample.raw) continue;

      const pseudoEntry: RegexLogEntry = {
        raw: sample.raw,
        index: sample.lineIndex ?? 0,
        content: sample.content,
      };
      const target = this.getTextForTemplate(candidate, pseudoEntry, headPattern);
      if (!target.text) continue;

      const result = matchEntireLine(candidateRuntime.pattern, target.text);
      if (!result.matched) continue;

      const key = sample.template?.id ?? 'unknown';
      const template = templateMap.get(sample.template?.id ?? '');
      if (!template) continue;

      if (!conflicts.has(key)) {
        conflicts.set(key, { template, samples: [] });
      }
      conflicts.get(key)!.samples.push(sample.raw);
    }

    return Array.from(conflicts.values());
  }

  /**
   * Determines the appropriate text to use for template matching.
   * Returns content if template is content-only, otherwise returns raw log.
   */
  private getTextForTemplate(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): { text?: string; error?: string } {
    const contentOnly = Boolean(template.metadata?.['contentOnly']);
    if (!contentOnly) {
      return { text: sample.raw };
    }
    if (headPattern?.pattern && sample.content !== undefined) {
      return { text: sample.content };
    }
    // No content extracted; treat as failure.
    return { text: undefined, error: 'Head extraction missing content' };
  }
}
