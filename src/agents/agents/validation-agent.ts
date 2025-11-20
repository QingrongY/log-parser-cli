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
  TemplateValidationDiagnostics,
} from '../types.js';
import { matchEntireLine } from '../utils/regex.js';
import {
  buildValidationPrompt,
  VALIDATION_RESPONSE_SCHEMA,
  VALIDATION_SYSTEM_PROMPT,
} from '../prompts/validation.js';
import { extractJsonObject } from '../utils/json.js';

export interface ValidationAgentInput {
  template: LogTemplateDefinition;
  samples: string[];
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
    if (!input.template?.pattern) {
      return {
        status: 'needs-input',
        issues: ['Validation requires a template pattern.'],
      };
    }
    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Validation requires an LLM client to perform semantic review.'],
      };
    }

    if (this.containsForbiddenVariable(input.template)) {
      return {
        status: 'success',
        output: {
          isValid: false,
          diagnostics: [
            {
              sample: input.samples[0] ?? input.template.pattern,
              reason: 'Variable name "message" must remain STRUCTURE and cannot be treated as BUSINESS DATA.',
            },
          ],
        },
      };
    }

    const sampleAnalysis = this.validateSamples(input.template, input.samples ?? []);
    const diagnostics = [...sampleAnalysis.diagnostics];

    if (sampleAnalysis.sample) {
      const llmIssues = await this.assessWithLlm(input.template, sampleAnalysis.sample);
      diagnostics.push(...llmIssues);
    }

    return {
      status: 'success',
      output: {
        isValid: diagnostics.length === 0,
        diagnostics,
      },
    };
  }

  private validateSamples(
    template: LogTemplateDefinition,
    samples: string[],
  ): {
    diagnostics: TemplateValidationDiagnostics[];
    sample?: { text: string; captures: Record<string, string> };
  } {
    const issues: TemplateValidationDiagnostics[] = [];
    let representativeSample: { text: string; captures: Record<string, string> } | undefined;

    for (const sample of samples) {
      const result = matchEntireLine(template.pattern, sample);
      if (!result.matched) {
        issues.push({
          sample,
          reason: result.error ?? 'Sample did not match generated template.',
        });
        continue;
      }

      if (!representativeSample) {
        representativeSample = { text: sample, captures: result.variables };
      }
    }

    return { diagnostics: issues, sample: representativeSample };
  }

  private async assessWithLlm(
    template: LogTemplateDefinition,
    sample: { text: string; captures: Record<string, string> },
  ): Promise<TemplateValidationDiagnostics[]> {
    try {
      const prompt = buildValidationPrompt({
        pattern: template.pattern,
        variables: template.variables ?? [],
        sample: sample.text,
        captures: sample.captures,
      });
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
        sample: sample.text,
        reason,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM validation review failed; ignoring semantic check.', { message });
      return [];
    }
  }

  private containsForbiddenVariable(template: LogTemplateDefinition): boolean {
    return (template.variables ?? []).some(
      (variable) => variable.trim().toLowerCase() === 'message',
    );
  }
}

