/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Head pattern type definitions.
 * Extracted to break circular dependencies.
 */

export interface HeadPatternDefinition {
  pattern: string;
  notes?: string;
  samples?: Array<{ raw: string; content?: string }>;
}
