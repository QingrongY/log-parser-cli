/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../agents/types.js';
import { buildJsonOnlyInstruction, ensureJsonResponse } from './json-utils.js';

export interface GeminiLlmClientOptions {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  apiVersion?: string;
  baseUrl?: string;
}

type GeminiContentPart = { text?: string };

interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  text?: string;
}

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

export class GeminiLlmClient implements LlmClient {
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly defaults: Required<
    Pick<GeminiLlmClientOptions, 'temperature' | 'maxOutputTokens'>
  >;

  constructor(options: GeminiLlmClientOptions) {
    this.apiKey = options.apiKey;
    this.modelName = normalizeGeminiModel(options.model ?? DEFAULT_GEMINI_MODEL);
    this.apiVersion = options.apiVersion ?? 'v1beta';
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.defaults = {
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
    };
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const wantsJson =
      Boolean(request.responseSchema) ||
      request.responseMimeType === 'application/json';
    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature ?? this.defaults.temperature,
      maxOutputTokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
      ...(request.responseMimeType && { responseMimeType: request.responseMimeType }),
      ...(request.responseSchema && { responseSchema: request.responseSchema }),
    };

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: this.combinePrompts(request),
            },
          ],
        },
      ],
      generationConfig,
    };

    let response = await this.invoke(body);
    let output = this.extractContent(response);

    if (wantsJson) {
      try {
        const validated = ensureJsonResponse(output, request.responseSchema);
        output = validated.text;
      } catch {
        // Retry once with an explicit JSON-only instruction placed before the user prompt.
        const retryBody = {
          ...body,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: [
                    buildJsonOnlyInstruction(request.responseSchema),
                    this.combinePrompts(request),
                  ].join('\n\n'),
                },
              ],
            },
          ],
        };
        response = await this.invoke(retryBody);
        const retryOutput = this.extractContent(response);
        const validated = ensureJsonResponse(retryOutput, request.responseSchema);
        output = validated.text;
      }
    }

    return {
      output,
      raw: response,
    };
  }

  private combinePrompts(request: LlmCompletionRequest): string {
    if (request.systemPrompt?.trim()) {
      return `${request.systemPrompt.trim()}\n\n${request.prompt}`;
    }
    return request.prompt;
  }

  private async invoke(body: Record<string, unknown>): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/${this.apiVersion}/models/${this.modelName}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const message =
        (data && data.error?.message) ||
        (typeof data === 'string' ? data : 'Unknown Gemini API error');
      throw new Error(`Gemini request failed: ${message}`);
    }
    return data as GeminiResponse;
  }

  private extractContent(payload: GeminiResponse): string {
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part: GeminiContentPart) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (text) {
      return text;
    }
    if (typeof payload.text === 'string' && payload.text.length > 0) {
      return payload.text;
    }
    throw new Error('Gemini response did not include text content.');
  }
}

const normalizeGeminiModel = (model: string): string => {
  if (model.startsWith('google/')) {
    return model.replace(/^google\//, '');
  }
  return model;
};
