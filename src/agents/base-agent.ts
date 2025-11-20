/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMON_LOG_PARSER_KNOWLEDGE } from './knowledge.js';
import {
  type AgentContext,
  type AgentLogger,
  type AgentResult,
  type AgentTelemetry,
  type BaseAgentConfig,
  type LlmClient,
} from './types.js';

class NullLogger implements AgentLogger {
  constructor(_agentName: string) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    void message;
    void meta;
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  private log(level: string, message: string, meta?: Record<string, unknown>): void {
    void level;
    void message;
    void meta;
  }
}

/**
 * Base class for all semantic log parser agents.
 */
export abstract class BaseAgent<TInput, TOutput> {
  protected readonly name: string;
  protected readonly logger: AgentLogger;
  protected readonly telemetry?: AgentTelemetry;
  protected readonly llmClient?: LlmClient;
  protected readonly sharedKnowledge = COMMON_LOG_PARSER_KNOWLEDGE;

  constructor(protected readonly config: BaseAgentConfig) {
    this.name = config.name ?? `${config.kind}-agent`;
    this.logger = config.logger ?? new NullLogger(this.name);
    this.telemetry = config.telemetry;
    this.llmClient = config.llmClient;
  }

  async run(input: TInput, context: AgentContext = {}): Promise<AgentResult<TOutput>> {
    const lineNumber =
      typeof context.metadata?.['lineIndex'] === 'number'
        ? Number(context.metadata['lineIndex']) + 1
        : undefined;

    const prefix = lineNumber
      ? `[log-parser] line ${lineNumber}`
      : `[log-parser] ${this.name}`;

    try {
      const result = await this.handle(input, context);
      if (result.status === 'success') {
        console.log(`${prefix}: ${this.name} success`);
      } else {
        console.log(
          `${prefix}: ${this.name} failed -> ${(result.issues ?? []).join('; ') || result.status}`,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${prefix}: ${this.name} fatal-error -> ${message}`);
      return {
        status: 'fatal-error',
        issues: [message],
      };
    }
  }

  protected composePrompt(userInstruction: string, extraContext?: string): string {
    const contextBlock = extraContext ? `\n\nContext:\n${extraContext}` : '';
    return `${userInstruction}\n\nShared background knowledge:\n${this.sharedKnowledge}${contextBlock}`;
  }

  protected abstract handle(
    input: TInput,
    context: AgentContext,
  ): Promise<AgentResult<TOutput>>;
}

