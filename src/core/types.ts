/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LogTemplateDefinition,
  HeadPatternDefinition,
  TemplateValidationDiagnostics,
} from '../agents/index.js';

export interface LogProcessingOptions {
  runId?: string;
  sourceHint?: string;
  batchSize?: number;
  skipThreshold?: number;
}

export interface MatchedLogRecord {
  raw: string;
  content?: string;
  template: LogTemplateDefinition;
  variables: Record<string, string>;
  lineIndex?: number;
}

export interface TemplateLibrary {
  id: string;
  templates: LogTemplateDefinition[];
  matchedSamples: MatchedLogRecord[];
  nextTemplateNumber?: number;
  headPattern?: HeadPatternDefinition;
}

export interface TemplateManager {
  listLibraries(): Promise<string[]>;
  loadLibrary(id: string): Promise<TemplateLibrary>;
  saveTemplate(id: string, template: LogTemplateDefinition): Promise<LogTemplateDefinition>;
  deleteTemplate(libraryId: string, templateId: string): Promise<void>;
  recordMatches(id: string, matches: MatchedLogRecord[]): Promise<void>;
  saveHeadPattern?(libraryId: string, head: HeadPatternDefinition): Promise<void>;
}

export interface LogProcessingSummary {
  runId?: string;
  source: string;
  libraryId: string;
  totalLines: number;
  matched: number;
  unmatched: number;
  newTemplates: LogTemplateDefinition[];
  conflicts: TemplateConflict[];
  matchedRecords: MatchedLogRecord[];
  unmatchedSamples: string[];
  failures: FailureRecord[];
}

export interface TemplateConflict {
  candidate: LogTemplateDefinition;
  conflictsWith: LogTemplateDefinition[];
  diagnostics?: TemplateValidationDiagnostics[];
}

export interface FailureRecord {
  lineIndex: number;
  rawLog: string;
  stage: string;
  reason: string;
  timestamp: string;
  template?: LogTemplateDefinition;
  details?: Record<string, unknown>;
}
