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
import { normalizeRegexPattern } from '../utils/regex.js';
import { ensureValidRegex } from '../utils/validation.js';

interface RepairLlmResponse {
  pattern: string;
  note?: string;
}

const REPAIR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
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
    if (!input.template?.pattern) {
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
      pattern: input.template.pattern,
      variables: input.template.variables ?? [],
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
      ensureValidRegex(parsed.pattern);
      const normalizedPattern = normalizeRegexPattern(parsed.pattern);

      const changed = normalizedPattern !== input.template.pattern;

      return {
        status: 'success',
        output: {
          template: {
            ...input.template,
            pattern: normalizedPattern,
            metadata: {
              ...input.template.metadata,
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
