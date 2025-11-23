/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmClient } from '../agents/types.js';
import { AimlApiLlmClient, GeminiLlmClient } from '../llm/index.js';

export interface LlmEnvConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  apiVersion?: string;
  provider: 'aimlapi' | 'gemini';
}

const DEFAULT_MODEL = 'google/gemini-2.0-flash';

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
    return DEFAULT_MODEL;
  }
  return candidate;
};

export function resolveLlmConfigFromEnv(): LlmEnvConfig | undefined {
  const model = resolveModelFromEnv();

  if (process.env['AIMLAPI_API_KEY']) {
    return {
      provider: 'aimlapi',
      apiKey: process.env['AIMLAPI_API_KEY'],
      model,
      baseUrl: process.env['AIMLAPI_BASE_URL'],
    };
  }

  if (process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY']) {
    return {
      provider: 'gemini',
      apiKey: process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'],
      model,
      apiVersion: process.env['LOG_PARSER_GEMINI_API_VERSION'] ?? 'v1beta',
    };
  }

  return undefined;
}

export function createLlmClient(config: LlmEnvConfig | undefined): LlmClient | undefined {
  if (!config?.apiKey) {
    return undefined;
  }

  const common = {
    model: config.model ?? DEFAULT_MODEL,
    temperature: 0,
    maxOutputTokens: 1024,
  };

  if (config.provider === 'aimlapi') {
    return new AimlApiLlmClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      ...common,
    });
  }

  return new GeminiLlmClient({
    apiKey: config.apiKey,
    apiVersion: config.apiVersion,
    ...common,
  });
}
