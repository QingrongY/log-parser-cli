/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Log template type definitions.
 * Extracted to break circular dependencies between agents and core.
 */

export interface LogTemplateDefinition {
  id?: string;
  placeholderTemplate: string;
  // Values embedded in the annotated template, keyed by generated slot names (v1, v2, ...).
  placeholderVariables: Record<string, string>;
  // Derived regex for transient matching (not persisted)
  pattern?: string;
  variables?: string[];
  description?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface TemplateValidationDiagnostics {
  sample: string;
  reason: string;
}
