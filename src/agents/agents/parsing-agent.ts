/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAgent } from '../base-agent.js';
import type {
  AgentContext,
  AgentResult,
  BaseAgentConfig,
  LogTemplateDefinition,
} from '../types.js';
import { buildParsingPrompt, PARSING_SYSTEM_PROMPT } from '../prompts/parsing.js';
import { extractJsonObject } from '../utils/json.js';
import { normalizeRegexPattern } from '../utils/regex.js';
import { ensureValidRegex } from '../utils/validation.js';

export interface ParsingAgentInput {
  samples: string[];
  variableHints?: string[];
}

export interface ParsingAgentOutput extends LogTemplateDefinition {
  sampleCount: number;
  promptUsed: string;
}

interface ParsingLlmResponse {
  pattern: string;
  description?: string;
  example?: {
    structure?: string;
    business_data?: Record<string, string>;
  };
  'BUSINESS DATA'?: Record<string, string>;
}

interface LlmParsingResult {
  template: LogTemplateDefinition;
  prompt: string;
}

const PARSING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern', 'BUSINESS DATA'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
    'BUSINESS DATA': {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    description: { type: 'string' },
    example: {
      type: 'object',
      additionalProperties: false,
      properties: {
        structure: { type: 'string' },
        business_data: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
};

export class ParsingAgent extends BaseAgent<ParsingAgentInput, ParsingAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'parsing', ...config });
  }

  protected async handle(
    input: ParsingAgentInput,
    context: AgentContext,
  ): Promise<AgentResult<ParsingAgentOutput>> {
    const samples = input.samples ?? [];
    if (samples.length === 0) {
      return {
        status: 'needs-input',
        issues: ['Parsing requires at least one raw log sample.'],
      };
    }

    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Gemini client not configured; cannot derive template automatically.'],
      };
    }

    const variableHints = (input.variableHints ?? []).map((hint) =>
      hint.trim().toLowerCase(),
    );

    try {
      const llmResult = await this.generateWithLlm(samples[0], variableHints, context);
      return {
        status: 'success',
        output: {
          ...llmResult.template,
          sampleCount: samples.length,
          promptUsed: llmResult.prompt,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM parsing failed', { message });
      return {
        status: 'retryable-error',
        issues: [`LLM parsing failed: ${message}`],
      };
    }
  }

  private async generateWithLlm(
    sample: string,
    variableHints: string[],
    context: AgentContext,
  ): Promise<LlmParsingResult> {
    const prompt = buildParsingPrompt({ logLine: sample, variableHints });

    const completion = await this.llmClient!.complete({
      prompt,
      systemPrompt: PARSING_SYSTEM_PROMPT,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: PARSING_RESPONSE_SCHEMA,
    });
    if (!completion.output?.trim()) {
      this.logger.warn('LLM returned empty response', {
        runId: context.runId,
        raw: safeSerialize(completion.raw),
      });
      throw new Error(`LLM returned empty response. raw=${safeSerialize(completion.raw)}`);
    }
    const parsed = extractJsonObject<ParsingLlmResponse>(completion.output);
    if (!parsed.pattern) {
      throw new Error('LLM response missing pattern.');
    }
    const businessData = parsed['BUSINESS DATA'] ?? {};
    const variables = this.normalizeVariables(Object.keys(businessData), variableHints);
    ensureValidRegex(parsed.pattern);

    const template: LogTemplateDefinition = {
      pattern: normalizeRegexPattern(parsed.pattern),
      variables,
      description: parsed.description ?? 'LLM-derived log template',
      source: context.templateLibraryId ?? context.sourceHint,
      metadata: {
        sample,
        variableHints,
        llmExample: parsed.example,
        llmModel: this.llmClient?.modelName,
        llmRaw: completion.output,
        llmBusinessData: businessData,
      },
    };

    return { template, prompt };
  }

  private normalizeVariables(candidates: string[], hints: string[]): string[] {
    const names = candidates.length > 0 ? candidates : hints;
    const normalized = names
      .map((name) => name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_'))
      .filter((name): name is string => Boolean(name));
    return Array.from(new Set(normalized));
  }
}

const safeSerialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};
