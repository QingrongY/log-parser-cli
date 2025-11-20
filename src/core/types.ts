/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LogTemplateDefinition,
  TemplateValidationDiagnostics,
} from '../agents/index.js';

export interface LogProcessingOptions {
  runId?: string;
  sourceHint?: string;
  variableHints?: string[];
  batchSize?: number;
  skipThreshold?: number;
}

export interface MatchedLogRecord {
  raw: string;
  template: LogTemplateDefinition;
  variables: Record<string, string>;
  lineIndex?: number;
}

export interface TemplateLibrary {
  id: string;
  templates: LogTemplateDefinition[];
  matchedSamples: MatchedLogRecord[];
  nextTemplateNumber?: number;
}

export interface TemplateManager {
  listLibraries(): Promise<string[]>;
  loadLibrary(id: string): Promise<TemplateLibrary>;
  saveTemplate(id: string, template: LogTemplateDefinition): Promise<LogTemplateDefinition>;
  recordMatches(id: string, matches: MatchedLogRecord[]): Promise<void>;
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
}

export interface TemplateConflict {
  candidate: LogTemplateDefinition;
  conflictsWith: LogTemplateDefinition[];
  diagnostics?: TemplateValidationDiagnostics[];
}
