/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type LogParserAgentKind =
  | 'routing'
  | 'parsing'
  | 'validation'
  | 'repair'
  | 'update'
  | 'interaction';

export type AgentRunStatus =
  | 'success'
  | 'needs-input'
  | 'retryable-error'
  | 'fatal-error';

export interface AgentContext {
  runId?: string;
  sourceHint?: string;
  templateLibraryId?: string;
  userPreferences?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentResult<TOutput = unknown> {
  status: AgentRunStatus;
  output?: TOutput;
  issues?: string[];
  diagnostics?: unknown;
}

export interface AgentLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentTelemetry {
  emit(event: string, payload?: Record<string, unknown>): void;
}

export interface LlmCompletionRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface LlmCompletionResponse {
  output: string;
  raw?: unknown;
}

export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
  modelName?: string;
}

export interface BaseAgentConfig {
  kind: LogParserAgentKind;
  name?: string;
  logger?: AgentLogger;
  telemetry?: AgentTelemetry;
  llmClient?: LlmClient;
}

export interface LogTemplateDefinition {
  id?: string;
  pattern: string;
  variables: string[];
  description?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface TemplateValidationDiagnostics {
  sample: string;
  reason: string;
}
