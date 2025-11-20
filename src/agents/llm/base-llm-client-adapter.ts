/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from '../types.js';

interface GeminiCliBaseLlmClient {
  generateJson(options: {
    modelConfigKey: { model: string; overrideScope?: string };
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    schema: Record<string, unknown>;
    systemInstruction?: string;
    abortSignal: AbortSignal;
    promptId: string;
    maxAttempts?: number;
  }): Promise<Record<string, unknown>>;
}

interface BaseLlmClientAdapterOptions {
  baseClient: GeminiCliBaseLlmClient;
  modelName: string;
  overrideScope?: string;
}

/**
 * Adapts the CLI's BaseLlmClient to the lightweight LLM interface used by the
 * log parser agents. The adapter requires callers to provide a JSON schema so
 * we can take advantage of generateJson's validation and retry behavior.
 */
export class BaseLlmClientAdapter implements LlmClient {
  readonly modelName: string;
  private readonly baseClient: GeminiCliBaseLlmClient;
  private readonly overrideScope: string;

  constructor(options: BaseLlmClientAdapterOptions) {
    this.baseClient = options.baseClient;
    this.modelName = options.modelName;
    this.overrideScope = options.overrideScope ?? 'log-parser';
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!request.responseSchema) {
      throw new Error(
        'BaseLlmClientAdapter requires responseSchema for JSON completions.',
      );
    }

    const promptId = `log-parser-${Date.now().toString(36)}`;
    const abortController = new AbortController();
    const json = await this.baseClient.generateJson({
      modelConfigKey: {
        model: this.modelName,
        overrideScope: this.overrideScope,
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: request.prompt }],
        },
      ],
      schema: request.responseSchema,
      systemInstruction: request.systemPrompt,
      abortSignal: abortController.signal,
      promptId,
    });

    return {
      output: JSON.stringify(json),
      raw: json,
    };
  }
}
