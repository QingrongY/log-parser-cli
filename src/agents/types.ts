/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-export shared types for backward compatibility.
 * Core type definitions have been moved to src/types/ to avoid circular dependencies.
 */

export type {
  LogParserAgentKind,
  AgentRunStatus,
  AgentContext,
  AgentResult,
  AgentLogger,
  AgentTelemetry,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmClient,
  BaseAgentConfig,
} from '../types/agent.js';

export type {
  LogTemplateDefinition,
  TemplateValidationDiagnostics,
} from '../types/template.js';

export type {
  HeadPatternDefinition,
} from '../types/head-pattern.js';
