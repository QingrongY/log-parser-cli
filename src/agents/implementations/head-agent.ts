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
  HeadPatternDefinition,
} from '../types.js';
import { buildHeadPromptBundle, HEAD_RESPONSE_SCHEMA } from '../prompts/head.js';
import { extractJsonObject } from '../utilities/json.js';
import { normalizeRegexPattern } from '../utilities/regex.js';

export interface HeadAgentInput {
  samples: string[];
  newSamples?: string[];
  maxExamples?: number;
  previousPattern?: string;
}

interface HeadLlmResponse {
  pattern: string;
  contentGroup?: string;
  namedGroups?: string[];
  notes?: string;
  samples?: Array<{ raw: string; content?: string }>;
}

export class HeadAgent extends BaseAgent<HeadAgentInput, HeadPatternDefinition> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'head', ...config });
  }

  protected async handle(
    input: HeadAgentInput,
    _context: AgentContext,
  ): Promise<AgentResult<HeadPatternDefinition>> {
    const samples = (input.samples ?? [])
      .filter((line) => typeof line === 'string' && line.trim().length > 0)
      .slice(0, input.maxExamples ?? 20);
    const newSamples = (input.newSamples ?? [])
      .filter((line) => typeof line === 'string' && line.trim().length > 0)
      .slice(0, input.maxExamples ?? 20);

    if (samples.length === 0) {
      return { status: 'needs-input', issues: ['Head extraction requires log samples.'] };
    }
    if (!this.llmClient) {
      return { status: 'needs-input', issues: ['LLM client not configured.'] };
    }

    const { systemPrompt, userPrompt } = buildHeadPromptBundle({
      samples,
      newSamples,
      previousPattern: input.previousPattern,
    });

    try {
      const completion = await this.llmClient.complete({
        prompt: userPrompt,
        systemPrompt,
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: HEAD_RESPONSE_SCHEMA,
      });

      const parsed = extractJsonObject<HeadLlmResponse>(completion.output);
      if (!parsed.pattern || typeof parsed.pattern !== 'string') {
        return {
          status: 'retryable-error',
          issues: ['LLM did not return a regex pattern.'],
          diagnostics: { llmOutput: completion.output },
        };
      }

      const normalizedPattern = normalizeRegexPattern(parsed.pattern);
      const output: HeadPatternDefinition = {
        pattern: normalizedPattern,
        notes: parsed.notes,
        samples: parsed.samples?.slice(0, 5),
      };

      return { status: 'success', output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Head agent failed to derive pattern', { message });
      return {
        status: 'retryable-error',
        issues: [`Head agent failed: ${message}`],
      };
    }
  }
}
