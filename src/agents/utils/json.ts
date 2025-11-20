/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const extractJsonObject = <T>(raw: string): T => {
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new Error('LLM returned empty response.');
  }

  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Unable to locate JSON object in LLM response.');
  }
  const jsonText = candidate.slice(start, end + 1);
  return JSON.parse(jsonText) as T;
};
