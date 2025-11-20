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
} from '../types.js';
import { buildRoutingPrompt, ROUTING_SYSTEM_PROMPT, ROUTING_RESPONSE_SCHEMA } from '../prompts/routing.js';
import { extractJsonObject } from '../utils/json.js';

export interface RoutingAgentInput {
  samples: string[];
  existingLibraries?: string[];
  sourceHint?: string;
}

export interface RoutingAgentOutput {
  source: string;
  libraryId: string;
  isNewLibrary: boolean;
  confidence: number;
}

export class RoutingAgent extends BaseAgent<RoutingAgentInput, RoutingAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'routing', ...config });
  }

  protected async handle(
    input: RoutingAgentInput,
    context: AgentContext,
  ): Promise<AgentResult<RoutingAgentOutput>> {
    const samples = input.samples ?? [];
    if (samples.length === 0) {
      return {
        status: 'needs-input',
        issues: ['Routing requires at least one log sample.'],
      };
    }

    let typeLabel = input.sourceHint ?? context.sourceHint;
    if (!typeLabel) {
      if (!this.llmClient) {
        return {
          status: 'needs-input',
          issues: ['Routing requires an LLM classification or a manual --source-hint.'],
        };
      }
      const inference = await this.inferLogType(samples.slice(0, 20), context);
      typeLabel = inference?.type;
    }

    if (!typeLabel) {
      return {
        status: 'needs-input',
        issues: ['Routing agent could not classify logs. Provide a --source-hint.'],
      };
    }

    const normalized = this.slugify(typeLabel);
    const source = normalized;
    const libraryId = normalized;
    const isNewLibrary = !(input.existingLibraries ?? []).includes(libraryId);
    const confidence = Math.min(1, samples.length / 10);

    return {
      status: 'success',
      output: {
        source,
        libraryId,
        isNewLibrary,
        confidence,
      },
    };
  }

  private async inferLogType(
    samples: string[],
    context: AgentContext,
  ): Promise<{ type?: string; note?: string } | undefined> {
    if (!this.llmClient) {
      return undefined;
    }
    try {
      const prompt = buildRoutingPrompt({ samples });
      const completion = await this.llmClient.complete({
        prompt,
        systemPrompt: ROUTING_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: ROUTING_RESPONSE_SCHEMA,
      });
      const parsed = extractJsonObject<{ type?: string; note?: string }>(completion.output);
      return parsed.type ? { type: parsed.type, note: parsed.note } : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM routing inference failed; using default type.', {
        message,
        runId: context.runId,
      });
      return undefined;
    }
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  }
}
