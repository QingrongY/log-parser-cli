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
import { buildRepairPrompt, REPAIR_SYSTEM_PROMPT } from '../prompts/repair.js';
import { extractJsonObject } from '../utils/json.js';
import { buildRegexFromTemplate } from './parsing-agent.js';
import { normalizeRegexPattern } from '../utils/regex.js';
import { ensureValidRegex } from '../utils/validation.js';

interface RepairLlmResponse {
  template: string;
  variables: Record<string, string>;
  note?: string;
}

const REPAIR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['template', 'variables'],
  properties: {
    template: { type: 'string', minLength: 1 },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    note: { type: 'string' },
  },
};

export interface RepairAgentInput {
  template: LogTemplateDefinition;
  diagnostics: TemplateValidationDiagnostics[];
  samples?: string[];
}

export interface RepairAgentOutput {
  template: LogTemplateDefinition;
  changed: boolean;
  note: string;
}

export class RepairAgent extends BaseAgent<RepairAgentInput, RepairAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'repair', ...config });
  }

  protected async handle(
    input: RepairAgentInput,
    _context: AgentContext,
  ): Promise<AgentResult<RepairAgentOutput>> {
    if (!input.template?.placeholderTemplate) {
      return {
        status: 'needs-input',
        issues: ['Repair requires the failed template definition.'],
      };
    }

    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Gemini client not configured; cannot repair automatically.'],
      };
    }

    if ((input.diagnostics ?? []).length === 0) {
      return {
        status: 'needs-input',
        issues: ['Repair requires diagnostics from validation.'],
      };
    }

    return this.tryRepairWithLlm(input, _context);
  }

  private async tryRepairWithLlm(
    input: RepairAgentInput,
    context: AgentContext,
  ): Promise<AgentResult<RepairAgentOutput>> {
    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Gemini client not configured; cannot repair automatically.'],
      };
    }

    const logLine = input.samples?.[0];
    const diagnostics = (input.diagnostics ?? []).map(
      (diag) => `${diag.sample}: ${diag.reason}`,
    );
    const prompt = buildRepairPrompt({
      logLine,
      template: input.template.metadata?.llmTemplate
        ? String(input.template.metadata.llmTemplate)
        : input.template.placeholderTemplate,
      variables:
        (input.template.metadata?.llmVariables as Record<string, string>) ??
        input.template.placeholderVariables ??
        {},
      diagnostics,
    });

    try {
      const completion = await this.llmClient.complete({
        prompt,
        systemPrompt: REPAIR_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: REPAIR_RESPONSE_SCHEMA,
      });
      const parsed = extractJsonObject<RepairLlmResponse>(completion.output);
      const sampleForRender =
        typeof logLine === 'string' && logLine.length > 0
          ? logLine
          : (input.template.metadata?.sample as string | undefined);
      const { pattern, variables } = buildRegexFromTemplate(parsed.template, parsed.variables, sampleForRender);
      const normalizedPattern = normalizeRegexPattern(pattern);
      ensureValidRegex(normalizedPattern);

      const changed =
        parsed.template !== input.template.placeholderTemplate ||
        JSON.stringify(parsed.variables ?? {}) !== JSON.stringify(input.template.placeholderVariables ?? {});

      return {
        status: 'success',
        output: {
          template: {
            ...input.template,
            placeholderTemplate: parsed.template,
            placeholderVariables: parsed.variables,
            pattern: normalizedPattern,
            variables,
            metadata: {
              ...input.template.metadata,
              llmTemplate: parsed.template,
              llmVariables: parsed.variables,
              repairedBy: this.llmClient.modelName,
              repairDiagnostics: diagnostics,
              repairRaw: completion.output,
            },
          },
          changed,
          note: parsed.note ?? (changed ? 'LLM-assisted repair applied.' : 'Template already satisfies diagnostics.'),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM repair failed.', { message });
      return {
        status: 'needs-input',
        issues: ['LLM repair failed; manual intervention required.'],
      };
    }
  }
}
