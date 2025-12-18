/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition } from '../../agents/index.js';
import { buildRegexFromTemplate } from '../../common/regex-builder.js';

/**
 * Compiled runtime representation of a template.
 */
export interface TemplateRuntime {
  pattern: string;
  regex: RegExp;
  variables: string[];
}

/**
 * Caches compiled template runtimes to avoid redundant regex compilation.
 * Provides significant performance improvement when matching against many log entries.
 *
 * Performance impact:
 * - Without cache: O(templates × log_entries) compilations
 * - With cache: O(templates) compilations
 *
 * For 1M log entries × 100 templates: saves ~100M regex compilations.
 */
export class TemplateRuntimeCache {
  private readonly cache = new Map<string, TemplateRuntime>();

  /**
   * Gets or compiles the runtime for a template.
   * Results are cached by template ID or content hash.
   *
   * @param template - The template to compile
   * @param sample - Optional sample text for regex validation
   * @returns Compiled template runtime, or undefined if compilation fails
   */
  getRuntime(template: LogTemplateDefinition, sample?: string): TemplateRuntime | undefined {
    const cacheKey = this.getCacheKey(template);

    // Return cached runtime if available
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Compile and cache
    try {
      const { pattern, variables } = buildRegexFromTemplate(
        template.placeholderTemplate,
        sample,
      );
      const regex = new RegExp(pattern);
      const runtime: TemplateRuntime = { pattern, regex, variables: variables ?? [] };

      this.cache.set(cacheKey, runtime);
      return runtime;
    } catch (error) {
      // Compilation failed, don't cache
      return undefined;
    }
  }

  /**
   * Clears the cache for a specific template.
   * Use when a template is updated or deleted.
   */
  invalidate(template: LogTemplateDefinition): void {
    const cacheKey = this.getCacheKey(template);
    this.cache.delete(cacheKey);
  }

  /**
   * Clears all cached runtimes.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns the number of cached templates.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Generates a stable cache key for a template.
   * Uses template ID if available, otherwise generates a content-based key.
   */
  private getCacheKey(template: LogTemplateDefinition): string {
    if (template.id) {
      return `id:${template.id}`;
    }

    // Generate content-based key for templates without IDs
    const contentKey = JSON.stringify({
      placeholder: template.placeholderTemplate,
      variables: template.placeholderVariables,
      pattern: template.pattern,
    });

    // Use a simple hash to keep keys manageable
    return `content:${this.simpleHash(contentKey)}`;
  }

  /**
   * Simple string hash function for cache keys.
   * Not cryptographically secure, but sufficient for caching.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}
