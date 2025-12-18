/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition, HeadPatternDefinition } from '../../agents/index.js';
import type { RegexLogEntry } from '../regex-worker-pool.js';
import { buildRegexFromTemplate } from '../../common/regex-builder.js';
import { matchEntireLine } from '../../agents/utilities/regex.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Validates that templates can properly match their samples.
 * Ensures templates generate valid regex patterns and correctly match expected logs.
 */
export class TemplateValidator {
  /**
   * Validates that a template correctly matches a given sample.
   *
   * @param template - The template to validate
   * @param sample - The log entry to match against
   * @param headPattern - Optional head pattern for content extraction
   * @returns Validation result with success status and any errors
   */
  async validate(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): Promise<ValidationResult> {
    const target = this.getTextForTemplate(template, sample, headPattern);
    if (!target.text) {
      return {
        valid: false,
        error: target.error ?? 'Template could not be applied to sample',
      };
    }

    let runtime;
    try {
      runtime = buildRegexFromTemplate(
        template.placeholderTemplate,
        template.placeholderVariables,
        target.text,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        error: reason,
      };
    }

    const matchResult = matchEntireLine(runtime.pattern, target.text);

    if (!matchResult.matched) {
      return {
        valid: false,
        error: 'Template regex does not match sample',
        details: { matchError: matchResult.error },
      };
    }

    return { valid: true };
  }

  /**
   * Attaches head pattern metadata to a template if a head pattern is in use.
   */
  attachHeadMetadata(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): LogTemplateDefinition {
    if (!headPattern) {
      return template;
    }
    const metadata = {
      ...(template.metadata ?? {}),
      contentOnly: true,
      headPattern: headPattern.pattern,
      rawSample: sample.raw,
      contentSample: sample.content ?? sample.raw,
    };
    return {
      ...template,
      metadata,
    };
  }

  /**
   * Determines the appropriate text to use for template validation.
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
