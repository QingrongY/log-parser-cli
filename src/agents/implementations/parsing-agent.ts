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
import { extractJsonObject } from '../utilities/json.js';
import { normalizeRegexPattern } from '../utilities/regex.js';
import { ensureValidRegex } from '../utilities/validation.js';
import { buildRegexFromTemplate } from '../../common/regex-builder.js';

export interface ParsingAgentInput {
  samples: string[];
  variableHints?: string[];
  failedTemplate?: string;
  failedReconstruction?: string;
}

export interface ParsingAgentOutput extends LogTemplateDefinition {
  sampleCount: number;
}

interface ParsingLlmResponse {
  template: string;
  variables: Record<string, string>;
  description?: string;
  example?: Record<string, unknown>;
}

interface LlmParsingResult {
  template: LogTemplateDefinition;
}

class ParsingFailureError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const PARSING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['template', 'variables'],
  properties: {
    template: { type: 'string', minLength: 1 },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    description: { type: 'string' },
    example: { type: 'object' },
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

    const prompt = buildParsingPrompt({
      logLine: samples[0],
      variableHints,
      failedTemplate: input.failedTemplate,
      failedRendered: input.failedReconstruction,
    });

    try {
      const llmResult = await this.generateWithLlm(
        samples[0],
        variableHints,
        context,
        prompt,
      );
      return {
        status: 'success',
        output: {
          ...llmResult.template,
          sampleCount: samples.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details =
        error instanceof ParsingFailureError ? error.details : undefined;
      this.logger.warn('LLM parsing failed', { message, details });
      return {
        status: 'retryable-error',
        issues: [`LLM parsing failed: ${message}`],
        diagnostics: { ...(details ?? {}) },
      };
    }
  }

  private async generateWithLlm(
    sample: string,
    variableHints: string[],
    context: AgentContext,
    prompt: string,
  ): Promise<LlmParsingResult> {
    const renderTemplate = (tpl: string, vars: Record<string, string>): string =>
      tpl.replace(/\u001b]9;var=([^\u0007]+)\u0007/g, (_m, name) => vars[name] ?? '');
    let parsed: ParsingLlmResponse | undefined;
    let reconstruction: string | undefined;
    const completion = await this.llmClient!.complete({
      prompt,
      systemPrompt: PARSING_SYSTEM_PROMPT,
      temperature: 0.1,
      responseMimeType: 'application/json',
    });

    try {
      if (!completion.output?.trim()) {
        throw new ParsingFailureError('LLM returned empty response.', {
          llmRaw: safeSerialize(completion.raw),
        });
      }
      parsed = this.parseJsonSafe<ParsingLlmResponse>(completion.output);
      if (!parsed.template) {
        throw new ParsingFailureError('LLM response missing template with placeholders.', {
          llmOutput: completion.output,
        });
      }
      if (!parsed.variables || typeof parsed.variables !== 'object') {
        throw new ParsingFailureError('LLM response missing variables map.', {
          llmOutput: completion.output,
        });
      }
      try {
        reconstruction = renderTemplate(parsed.template, parsed.variables);
      } catch {
        reconstruction = undefined;
      }

      let pattern: string;
      let variables: string[];
      try {
        const built = buildRegexFromTemplate(parsed.template, parsed.variables, sample);
        pattern = built.pattern;
        variables = built.variables;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ParsingFailureError(message, {
          failedTemplate: parsed.template,
          failedVariables: parsed.variables,
          failedReconstruction: reconstruction,
        });
      }
      const normalizedPattern = normalizeRegexPattern(pattern);
      ensureValidRegex(normalizedPattern);
      const template: LogTemplateDefinition = {
        placeholderTemplate: parsed.template,
        placeholderVariables: parsed.variables,
        pattern: normalizedPattern,
        variables,
        description: parsed.description ?? 'LLM-placeholder log template',
        source: context.templateLibraryId ?? context.sourceHint,
        metadata: {
          sample,
          variableHints,
          taggedSample: parsed.template,
          llmExample: parsed.example,
          llmModel: this.llmClient?.modelName,
          llmRaw: completion.output,
          llmTemplate: parsed.template,
          llmVariables: parsed.variables,
        },
      };

      return { template };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details =
        error instanceof ParsingFailureError ? error.details : undefined;
      const enriched = {
        ...(details ?? {}),
        failedTemplate: details?.failedTemplate ?? parsed?.template,
        failedVariables: details?.failedVariables ?? parsed?.variables,
        failedReconstruction: details?.failedReconstruction ?? reconstruction,
        llmOutput: completion.output,
      };
      throw new ParsingFailureError(message, {
        ...enriched,
      });
    }
  }
}

const safeSerialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

// Re-export for backward compatibility
export { buildRegexFromTemplate } from '../../common/regex-builder.js';
