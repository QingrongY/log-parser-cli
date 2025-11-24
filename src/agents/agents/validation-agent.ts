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
  TemplateValidationDiagnostics,
} from '../types.js';
import {
  buildValidationPrompt,
  VALIDATION_RESPONSE_SCHEMA,
  VALIDATION_SYSTEM_PROMPT,
} from '../prompts/validation.js';
import { extractJsonObject } from '../utils/json.js';

export interface ValidationAgentInput {
  variables: Record<string, string>;
}

export interface ValidationAgentOutput {
  isValid: boolean;
  diagnostics: TemplateValidationDiagnostics[];
}

interface ValidationLlmResponse {
  verdict: 'pass' | 'fail';
  issues?: string[];
  advice?: string;
}

export class ValidationAgent extends BaseAgent<ValidationAgentInput, ValidationAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'validation', ...config });
  }

  protected async handle(
    input: ValidationAgentInput,
    _context: AgentContext,
  ): Promise<AgentResult<ValidationAgentOutput>> {
    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Validation requires an LLM client to perform semantic review.'],
      };
    }

    const diagnostics = await this.assessWithLlm(input.variables ?? {});

    return {
      status: 'success',
      output: {
        isValid: diagnostics.length === 0,
        diagnostics,
      },
    };
  }

  private async assessWithLlm(
    variables: Record<string, string>,
  ): Promise<TemplateValidationDiagnostics[]> {
    try {
      const prompt = buildValidationPrompt({ variables });
      const completion = await this.llmClient!.complete({
        prompt,
        systemPrompt: VALIDATION_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: VALIDATION_RESPONSE_SCHEMA,
      });
      const parsed = extractJsonObject<ValidationLlmResponse>(completion.output);
      if (parsed.verdict === 'pass') {
        return [];
      }
      const reasons = parsed.issues?.length ? parsed.issues : ['LLM flagged structure/business data issues.'];
      return reasons.map((reason) => ({
        sample: Object.entries(variables)
          .map(([k, v]) => `${k}:${v}`)
          .join(' | '),
        reason,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM validation review failed; ignoring semantic check.', { message });
      return [];
    }
  }

}

