/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../types.js';

type TextPart = { text?: string };

export interface GeminiLlmClientOptions {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  apiVersion?: string;
}

export class GeminiLlmClient implements LlmClient {
  private readonly client: GoogleGenAI;
  private readonly defaults: Required<
    Pick<GeminiLlmClientOptions, 'temperature' | 'maxOutputTokens'>
  >;
  readonly modelName: string;

  constructor(options: GeminiLlmClientOptions) {
    const apiVersion = options.apiVersion ?? 'v1';
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: { apiVersion },
    });
    this.modelName = options.model ?? 'gemini-2.0-flash';
    this.defaults = {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
    };
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const combinedPrompt = request.systemPrompt?.trim()
      ? `${request.systemPrompt.trim()}\n\n${request.prompt}`
      : request.prompt;

    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents: [
        {
          role: 'user',
          parts: [{ text: combinedPrompt }],
        },
      ],
      config: {
        temperature: request.temperature ?? this.defaults.temperature,
        maxOutputTokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
        ...(request.responseMimeType && { responseMimeType: request.responseMimeType }),
        ...(request.responseSchema && { responseSchema: request.responseSchema }),
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part: TextPart) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    const responseTextAccessor = response as unknown as { text?: () => string | undefined };
    const fallbackText =
      typeof responseTextAccessor.text === 'function' ? responseTextAccessor.text() ?? '' : '';

    return {
      output: text || fallbackText,
      raw: response,
    };
  }
}
