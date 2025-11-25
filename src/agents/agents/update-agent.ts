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
import { matchEntireLine, normalizeRegexPattern } from '../utils/regex.js';
import { buildRegexFromTemplate } from './parsing-agent.js';
import {
  buildUpdatePrompt,
  UPDATE_RESPONSE_SCHEMA,
  UPDATE_SYSTEM_PROMPT,
} from '../prompts/update.js';
import { extractJsonObject } from '../utils/json.js';
import { ensureValidRegex } from '../utils/validation.js';
interface TemplateSampleSummary {
  raw: string;
  templateId?: string;
}

interface ConflictDetails {
  template: LogTemplateDefinition;
  samples: string[];
}

export interface UpdateAgentInput {
  template: LogTemplateDefinition;
  existingTemplates: LogTemplateDefinition[];
  librarySamples: TemplateSampleSummary[];
  candidateSamples?: string[];
}

export interface UpdateAgentOutput {
  action: 'added' | 'updated' | 'skipped' | 'conflict' | 'retry';
  template: LogTemplateDefinition;
  conflictingTemplates?: LogTemplateDefinition[];
  replacedTemplateIds?: string[];
  reason?: string;
}

interface UpdateLlmResponse {
  action: 'Modify candidate' | 'Modify existing';
  template: string;
  variables: Record<string, string>;
  explain?: string;
}

export class UpdateAgent extends BaseAgent<UpdateAgentInput, UpdateAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'update', ...config });
  }

  protected async handle(
    input: UpdateAgentInput,
    _context: AgentContext,
  ): Promise<AgentResult<UpdateAgentOutput>> {
    const existing = input.existingTemplates ?? [];
    const duplicate = existing.find((candidate) =>
      this.isEquivalent(candidate, input.template),
    );
    if (duplicate) {
      return {
        status: 'success',
        output: {
          action: 'skipped',
          reason: 'duplicate-template',
          template: duplicate,
        },
      };
    }

    const conflicts = this.findConflicts(
      input.template,
      existing,
      input.librarySamples ?? [],
    );

    if (conflicts.length === 0) {
      return {
        status: 'success',
        output: {
          action: 'added',
          reason: 'no-conflicts',
          template: input.template,
        },
      };
    }

    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Update agent requires LLM to resolve overlapping templates.'],
        output: {
          action: 'conflict',
          reason: 'conflicts-detected',
          template: input.template,
          conflictingTemplates: conflicts.map((entry) => entry.template),
        },
      };
    }

    return this.resolveConflictWithLlm(input, conflicts, _context);
  }

  private isEquivalent(a: LogTemplateDefinition, b: LogTemplateDefinition): boolean {
    return (
      a.placeholderTemplate === b.placeholderTemplate &&
      this.compareVariablesMap(a.placeholderVariables, b.placeholderVariables)
    );
  }

  private compareVariablesMap(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
    const aEntries = Object.entries(a).sort();
    const bEntries = Object.entries(b).sort();
    if (aEntries.length !== bEntries.length) {
      return false;
    }
    return aEntries.every(([k, v], idx) => k === bEntries[idx][0] && v === bEntries[idx][1]);
  }

  private toRuntime(template?: LogTemplateDefinition): { pattern: string; variables: string[] } {
    if (!template) {
      return { pattern: '', variables: [] };
    }
    const { pattern, variables } = buildRegexFromTemplate(
      template.placeholderTemplate,
      template.placeholderVariables,
      template.metadata?.sample as string | undefined,
    );
    return { pattern, variables };
  }

  private findConflicts(
    candidate: LogTemplateDefinition,
    existingTemplates: LogTemplateDefinition[],
    samples: TemplateSampleSummary[],
  ): ConflictDetails[] {
    const runtimeCandidate = this.toRuntime(candidate);
    const conflicts = new Map<string, ConflictDetails>();
    const templateMap = new Map(existingTemplates.map((template) => [template.id ?? '', template]));

    for (const sample of samples) {
      if (!sample.raw) {
        continue;
      }
      const result = matchEntireLine(runtimeCandidate.pattern, sample.raw);
      if (!result.matched) {
        continue;
      }
      const key = sample.templateId ?? 'unknown';
      const template = templateMap.get(sample.templateId ?? '') ?? existingTemplates.find((entry) => entry.id === sample.templateId);
      if (!template) {
        continue;
      }
      if (!conflicts.has(key)) {
        conflicts.set(key, { template, samples: [] });
      }
      conflicts.get(key)!.samples.push(sample.raw);
    }

    return Array.from(conflicts.values());
  }

  private async resolveConflictWithLlm(
    input: UpdateAgentInput,
    conflicts: ConflictDetails[],
    context: AgentContext,
  ): Promise<AgentResult<UpdateAgentOutput>> {
    const prompt = buildUpdatePrompt({
      candidate: input.template,
      candidateSamples: input.candidateSamples ?? [],
      conflicts: conflicts.map((entry) => ({
        id: entry.template.id,
        template: entry.template.placeholderTemplate,
        variables: entry.template.placeholderVariables,
        samples: entry.samples,
      })),
    });

    try {
      const completion = await this.llmClient!.complete({
        prompt,
        systemPrompt: UPDATE_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: UPDATE_RESPONSE_SCHEMA,
      });
      const parsed = extractJsonObject<UpdateLlmResponse>(completion.output);
      const sampleForRender =
        typeof input.candidateSamples?.[0] === 'string'
          ? input.candidateSamples[0]
          : typeof input.template.metadata?.sample === 'string'
            ? (input.template.metadata.sample as string)
            : input.template.placeholderTemplate;
      const { pattern, variables } = buildRegexFromTemplate(parsed.template, parsed.variables, sampleForRender);
      const normalizedPattern = normalizeRegexPattern(pattern);
      ensureValidRegex(normalizedPattern);
      const note = parsed.explain ?? 'LLM conflict resolution';

      if (parsed.action === 'Modify candidate') {
        return {
          status: 'success',
          output: {
            action: 'retry',
            template: {
              ...input.template,
              placeholderTemplate: parsed.template,
              placeholderVariables: parsed.variables,
              pattern: normalizedPattern,
              variables: Object.keys(parsed.variables ?? {}),
            },
            reason: note,
          },
        };
      }

      if (parsed.action === 'Modify existing') {
        const adjustedTemplate: LogTemplateDefinition = {
          ...input.template,
          placeholderTemplate: parsed.template,
          placeholderVariables: parsed.variables,
          pattern: normalizedPattern,
          variables: Object.keys(parsed.variables ?? {}),
        };
        const replacedIds = conflicts
          .map((entry) => entry.template.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (replacedIds.length === 0) {
          return {
            status: 'needs-input',
            issues: ['LLM suggested modifying existing templates but no template IDs were provided.'],
            output: {
              action: 'conflict',
              reason: 'missing-template-ids',
              template: input.template,
              conflictingTemplates: conflicts.map((entry) => entry.template),
            },
          };
        }
        return {
          status: 'success',
          output: {
            action: 'updated',
            template: adjustedTemplate,
            replacedTemplateIds: replacedIds,
            reason: note,
          },
        };
      }

      return {
        status: 'needs-input',
        issues: ['LLM response was invalid for conflict resolution.'],
        output: {
          action: 'conflict',
          reason: 'llm-invalid-response',
          template: input.template,
          conflictingTemplates: conflicts.map((entry) => entry.template),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM update resolution failed.', {
        message,
        runId: context.runId,
      });
      return {
        status: 'needs-input',
        issues: ['LLM conflict resolution failed; manual review required.'],
        output: {
          action: 'conflict',
          reason: 'llm-error',
          template: input.template,
          conflictingTemplates: conflicts.map((entry) => entry.template),
        },
      };
    }
  }
}
