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
import { buildValidationPrompt, VALIDATION_RESPONSE_SCHEMA, VALIDATION_SYSTEM_PROMPT } from '../prompts/validation.js';
import { extractJsonObject } from '../utils/json.js';

export interface ValidationAgentInput {
  sample: string;
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
    const diagnostics = this.assessLocally(input.variables ?? {});
    return {
      status: 'success',
      output: {
        isValid: diagnostics.length === 0,
        diagnostics,
      },
    };
  }

  private assessLocally(variables: Record<string, string>): TemplateValidationDiagnostics[] {
    const issues: TemplateValidationDiagnostics[] = [];
    const tsPattern = /^timestamp\d*$/i;
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value !== 'string') continue;
      if (tsPattern.test(name)) {
        continue;
      }
      if (value.includes(' ')) {
        issues.push({
          sample: `${name}:${value}`,
          reason: `${name} contains spaces and is likely STRUCTURE, timestamp names are exempt.`,
        });
      }
    }
    return issues;
  }
}

