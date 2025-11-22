/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../agents/types.js';
import { buildJsonOnlyInstruction, ensureJsonResponse } from './json-utils.js';

export interface AimlApiLlmClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

type AimlChatChoice = {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
  text?: string;
};

interface AimlChatResponse {
  choices?: AimlChatChoice[];
  output_text?: string;
}

const DEFAULT_AIML_MODEL = 'google/gemini-2.0-flash';

export class AimlApiLlmClient implements LlmClient {
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaults: Required<
    Pick<AimlApiLlmClientOptions, 'temperature' | 'maxOutputTokens'>
  >;

  constructor(options: AimlApiLlmClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.aimlapi.com';
    this.modelName = normalizeAimlModel(options.model ?? DEFAULT_AIML_MODEL);
    this.defaults = {
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
    };
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const wantsJson =
      Boolean(request.responseSchema) ||
      request.responseMimeType === 'application/json';

    const baseBody: Record<string, unknown> = {
      model: this.modelName,
      messages: this.buildMessages(request),
      temperature: request.temperature ?? this.defaults.temperature,
      max_tokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
    };
    if (wantsJson) {
      baseBody['response_format'] = { type: 'json_object' };
    }

    let response = await this.invoke(baseBody);
    let output = this.extractContent(response);

    if (wantsJson) {
      try {
        const validated = ensureJsonResponse(output, request.responseSchema);
        output = validated.text;
      } catch (error) {
        // Retry once with an explicit JSON-only instruction to salvage schema compliance.
        const retryBody = {
          ...baseBody,
          messages: [
            ...(request.systemPrompt
              ? [{ role: 'system', content: request.systemPrompt }]
              : []),
            {
              role: 'system',
              content: buildJsonOnlyInstruction(request.responseSchema),
            },
            { role: 'user', content: request.prompt },
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

  private buildMessages(request: LlmCompletionRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: request.systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: request.prompt });
    return messages;
  }

  private async invoke(body: Record<string, unknown>): Promise<AimlChatResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const message =
        (data && data.message) ||
        (typeof data === 'string' ? data : 'Unknown AIML API error');
      throw new Error(`AIMLAPI request failed: ${message}`);
    }
    return data as AimlChatResponse;
  }

  private extractContent(payload: AimlChatResponse): string {
    const choice = payload.choices?.[0];
    if (choice?.message?.content) {
      if (typeof choice.message.content === 'string') {
        return choice.message.content;
      }
      if (Array.isArray(choice.message.content)) {
        const parts = choice.message.content
          .map((part) => part.text ?? '')
          .filter(Boolean);
        if (parts.length > 0) {
          return parts.join('\n');
        }
      }
    }
    if (typeof choice?.text === 'string') {
      return choice.text;
    }
    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }
    throw new Error('AIMLAPI response did not include text content.');
  }
}

const normalizeAimlModel = (model: string): string => {
  if (model.startsWith('google/')) {
    return model;
  }
  // AIML models use google/<model> for Gemini variants; apply prefix if missing.
  if (model.startsWith('gemini-')) {
    return `google/${model}`;
  }
  return model;
};
