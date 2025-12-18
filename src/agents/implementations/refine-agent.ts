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
import {
  extractVariablesFromTemplate,
  type ExtractedTemplateVariables,
} from '../../common/template-variable-extractor.js';
import {
  buildRefinePrompt,
  REFINE_RESPONSE_SCHEMA,
  REFINE_SYSTEM_PROMPT,
} from '../prompts/refine.js';

export interface RefineAgentInput {
  candidateTemplate: LogTemplateDefinition;
  candidateSamples: string[];
  conflictingTemplate: LogTemplateDefinition;
  conflictingSamples: string[];
}

export interface RefineAgentOutput {
  action: 'refine_candidate' | 'adopt_candidate';
  template: LogTemplateDefinition;
  reason?: string;
}

interface RefineLlmResponse {
  action: 'refine_candidate' | 'adopt_candidate';
  template: string;
  explain?: string;
}

export class RefineAgent extends BaseAgent<RefineAgentInput, RefineAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'refine', ...config });
  }

  protected async handle(
    input: RefineAgentInput,
    _context: AgentContext,
  ): Promise<AgentResult<RefineAgentOutput>> {
    const prompt = buildRefinePrompt({
      candidate: input.candidateTemplate,
      candidateSamples: input.candidateSamples,
      conflicting: input.conflictingTemplate,
      conflictingSamples: input.conflictingSamples,
    });

    const completion = await this.llmClient!.complete({
      prompt,
      systemPrompt: REFINE_SYSTEM_PROMPT,
      temperature: 0.1,
      responseMimeType: 'application/json',
    });

    this.logger.debug('Refine agent LLM response', {
      outputLength: completion.output?.length,
      outputPreview: completion.output?.substring(0, 200),
    });

    const parsed = this.parseJsonSafe<RefineLlmResponse>(completion.output);
    const note = parsed.explain ?? 'LLM refine decision';

    const { pattern: _ignoredPattern, ...baseTemplate } = input.candidateTemplate;

    const primarySample = input.candidateSamples?.[0] ?? input.conflictingSamples?.[0];
    let extracted: ExtractedTemplateVariables;

    try {
      extracted = extractVariablesFromTemplate(parsed.template, primarySample);
    } catch (error) {
      const extractionError = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to extract variables from template during refine: ${extractionError}`,
      );
    }

    const refinedTemplate: LogTemplateDefinition = {
      ...baseTemplate,
      placeholderTemplate: parsed.template,
      placeholderVariables: extracted.variables,
      variables: extracted.order,
    };

    if (parsed.action === 'refine_candidate') {
      return {
        status: 'success',
        output: {
          action: 'refine_candidate',
          template: refinedTemplate,
          reason: note,
        },
      };
    }

    if (parsed.action === 'adopt_candidate') {
      return {
        status: 'success',
        output: {
          action: 'adopt_candidate',
          template: refinedTemplate,
          reason: note,
        },
      };
    }

    throw new Error(`LLM response has invalid action: ${parsed.action}`);
  }
}
