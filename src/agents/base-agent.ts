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
import { extractJsonObject } from './utilities/json.js';

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
      if (result.status !== 'success') {
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

  protected parseJsonSafe<T>(text: string): T {
    const sanitized = this.sanitizeJsonish(text);
    const cleaned = sanitized.trim();
    if (!cleaned) {
      throw new Error('LLM returned empty response.');
    }

    const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch ? fencedMatch[1] : cleaned;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Unable to locate JSON object in LLM response.');
    }

    const jsonText = candidate.slice(start, end + 1);

    try {
      return JSON.parse(jsonText) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorPos = message.match(/position (\d+)/)?.[1];
      const pos = errorPos ? parseInt(errorPos) : -1;

      const debugInfo = {
        agent: this.name,
        originalLength: text.length,
        sanitizedLength: sanitized.length,
        jsonTextPreview: jsonText.substring(0, 300),
        jsonTextSample: this.debugShowControlChars(jsonText.substring(0, 150)),
        errorPosition: errorPos,
        contextAroundError: pos > 0 ? this.debugShowControlChars(jsonText.substring(Math.max(0, pos - 30), pos + 30)) : undefined,
      };

      this.logger.error(`JSON parse failed in ${this.name}: ${message}`, debugInfo);

      const errorDetails = [
        message,
        `Agent: ${this.name}`,
        `LLM output (first 100 chars): ${this.debugShowControlChars(text.substring(0, 100))}`,
        errorPos ? `Context around error pos ${errorPos}: ${this.debugShowControlChars(jsonText.substring(Math.max(0, pos - 30), Math.min(jsonText.length, pos + 30)))}` : '',
      ].filter(Boolean).join('\n');

      throw new Error(errorDetails);
    }
  }

  private debugShowControlChars(text: string): string {
    return text.replace(/[\u0000-\u001f]/g, (ch) =>
      `<0x${ch.charCodeAt(0).toString(16).padStart(2, '0')}>`
    );
  }

  private sanitizeJsonish(text: string): string {
    let sanitized = text.replace(/```(?:json)?/gi, '');
    sanitized = sanitized.replace(/[\u0000-\u001f]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x0a || code === 0x0d || code === 0x09) {
        return ch;
      }
      return `\\u${code.toString(16).padStart(4, '0')}`;
    });
    return sanitized;
  }

  protected abstract handle(
    input: TInput,
    context: AgentContext,
  ): Promise<AgentResult<TOutput>>;
}

