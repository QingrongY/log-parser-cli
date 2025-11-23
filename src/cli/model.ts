/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const DEFAULT_LOG_PARSER_MODEL = 'google/gemini-2.0-flash';

export const resolveModelFromEnv = (): string => {
  const candidate =
    process.env['LOG_PARSER_LLM_MODEL'] ??
    process.env['LOG_PARSER_AIMLAPI_MODEL'] ??
    process.env['AIMLAPI_MODEL'] ??
    process.env['LOG_PARSER_GEMINI_MODEL'] ??
    process.env['GEMINI_MODEL'];
  const deprecated = new Set([
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ]);
  if (!candidate || deprecated.has(candidate)) {
    return DEFAULT_LOG_PARSER_MODEL;
  }
  return candidate;
};
