/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractJsonObject } from '../agents/utils/json.js';

interface SchemaObject {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface JsonValidationResult<T> {
  parsed: T;
  text: string;
}

/**
 * Attempts to parse JSON from a model response and performs a lightweight
 * schema check (required keys) to guard against malformed outputs.
 */
export function ensureJsonResponse<T = unknown>(
  rawText: string,
  schema?: Record<string, unknown>,
): JsonValidationResult<T> {
  const parsed = extractJsonObject<T>(rawText);
  if (!parsed) {
    throw new Error('LLM response did not contain valid JSON.');
  }
  const missing = findMissingKeys(parsed as Record<string, unknown>, schema);
  if (missing.length > 0) {
    throw new Error(`LLM JSON missing required field(s): ${missing.join(', ')}`);
  }
  return {
    parsed,
    text: JSON.stringify(parsed),
  };
}

const findMissingKeys = (
  value: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string[] => {
  if (!schema) {
    return [];
  }
  const schemaObj = schema as SchemaObject;
  if (schemaObj.type !== 'object' || !Array.isArray(schemaObj.required)) {
    return [];
  }
  return schemaObj.required.filter((key) => !(key in value));
};

/**
 * Convenience helper to prepend a JSON-only reminder.
 */
export const buildJsonOnlyInstruction = (
  schema?: Record<string, unknown>,
): string => {
  const schemaText = schema ? `\nSchema:\n${JSON.stringify(schema)}` : '';
  return `Return ONLY a valid JSON object that strictly follows the requested structure.${schemaText}`;
};
