/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ParsingAgent,
  RoutingAgent,
  RefineAgent,
  HeadAgent,
  type LlmClient,
} from '../agents/index.js';
import {
  LogProcessingPipeline,
  RegexWorkerPool,
  type TemplateManager,
  type ProcessingObserver,
  type TemplateConflict,
  type FailureRecord,
} from '../core/index.js';
import {
  SqliteTemplateManager,
  getLibraryDatabasePath,
} from '../tools/index.js';
import { streamLogBatches, estimateBatchTotal } from './batch-processor.js';
import { writeChunkFile } from './chunk-manager.js';
import { writeConflictReport, writeFailureReport } from './report-writers.js';
import { replayMatchPhase, type ChunkRecord } from './replay-matcher.js';

export interface SemanticLogParserOptions {
  inputPath: string;
  outputDir: string;
  llmClient?: LlmClient;
  limit?: number;
  batchSize?: number;
  sourceHint?: string;
  templateManager?: TemplateManager;
  regexWorkerPool?: RegexWorkerPool;
  templateLibraryDir?: string;
  reportDir?: string;
  chunkDir?: string;
  runId?: string;
  observer?: ProcessingObserver;
  matchOnly?: boolean;
  libraryId?: string;
  skipThreshold?: number;
}

export interface SemanticLogParserResult {
  runId: string;
  totalLines: number;
  matched: number;
  unmatched: number;
  templatesUpdated: number;
  conflictsDetected: number;
  templateLibraryPaths: string[];
  reportPath: string;
  chunkDirectory: string;
  conflictReportPath?: string;
  failureReportPath?: string;
}

/**
 * Main entry point for semantic log parsing.
 * Coordinates the full pipeline: routing, parsing, refinement, and matching.
 */
export async function runSemanticLogParser(
  options: SemanticLogParserOptions,
): Promise<SemanticLogParserResult> {
  if (!process.env.FORCE_COLOR) {
    process.env.FORCE_COLOR = '1';
  }

  const runId = options.runId ?? randomUUID();
  const templateLibraryDir =
    options.templateLibraryDir ?? join(options.outputDir, 'template-libraries');
  const reportDir = options.reportDir ?? join(options.outputDir, 'reports');
  const chunkDir = options.chunkDir ?? join(options.outputDir, 'log-chunks');
  const reportPath = join(reportDir, `${runId}-matches.csv`);
  const batchSize = options.batchSize ?? 50_000;
  const estimatedTotalBatches = await estimateBatchTotal(
    options.inputPath,
    batchSize,
    options.limit,
  );

  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.mkdir(templateLibraryDir, { recursive: true });
  await fs.rm(chunkDir, { recursive: true, force: true });
  await fs.mkdir(chunkDir, { recursive: true });

  const templateManager: TemplateManager =
    options.templateManager ??
    new SqliteTemplateManager({
      baseDir: templateLibraryDir,
    });
  const regexWorkerPool: RegexWorkerPool =
    options.regexWorkerPool ?? new RegexWorkerPool();

  const failureLogPath = join(reportDir, `${runId}-failures.jsonl`);
  await fs.writeFile(failureLogPath, '', 'utf-8');

  if (options.matchOnly) {
    if (!options.libraryId) {
      throw new Error('--match-only requires a template library ID.');
    }
    const chunkRecords: ChunkRecord[] = [];
    const matchChunkDir = join(options.outputDir, 'match-only-chunks');
    await fs.rm(matchChunkDir, { recursive: true, force: true });
    await fs.mkdir(matchChunkDir, { recursive: true });
    let chunkIndex = 0;
    for await (const batch of streamLogBatches(options.inputPath, batchSize, options.limit)) {
      if (batch.length === 0) {
        continue;
      }
      chunkIndex += 1;
      options.observer?.onBatchProgress?.({ current: chunkIndex, total: undefined });
      const chunkPath = await writeChunkFile(matchChunkDir, options.libraryId, chunkIndex, batch);
      if (chunkPath) {
        chunkRecords.push({ path: chunkPath, libraryId: options.libraryId });
      }
    }
    if (chunkRecords.length === 0) {
      throw new Error('No log lines found in input file.');
    }
    const replayStats = await replayMatchPhase({
      chunkRecords,
      templateManager,
      regexWorkerPool,
      reportPath,
    });
    const templateLibraryPaths = [
      getLibraryDatabasePath(templateLibraryDir, options.libraryId),
    ];
    return {
      runId,
      totalLines: replayStats.totalLines,
      matched: replayStats.matched,
      unmatched: replayStats.unmatched,
      templatesUpdated: 0,
      conflictsDetected: 0,
      templateLibraryPaths,
      reportPath,
      chunkDirectory: matchChunkDir,
    };
  }

  const pipeline = new LogProcessingPipeline({
    agents: createDefaultAgents(options.llmClient!),
    templateManager,
    regexWorkerPool,
    observer: options.observer,
    failureLogPath,
  });

  const chunkRecords: ChunkRecord[] = [];
  const libraryIds = new Set<string>();
  let templatesUpdated = 0;
  let conflictsDetected = 0;
  const allConflicts: Array<{ lineIndex?: number; conflict: TemplateConflict }> = [];
  const allFailures: FailureRecord[] = [];
  let chunkIndex = 0;
  let firstPassLines = 0;

  for await (const batch of streamLogBatches(options.inputPath, batchSize, options.limit)) {
    if (batch.length === 0) {
      continue;
    }
    chunkIndex += 1;
    options.observer?.onBatchProgress?.({
      current: chunkIndex,
      total: estimatedTotalBatches,
    });
    const summary = await pipeline.process(batch, {
      runId,
      sourceHint: options.sourceHint,
      batchSize: 1,
      skipThreshold: options.skipThreshold,
    });
    firstPassLines += summary.totalLines;
    templatesUpdated += summary.newTemplates.length;
    conflictsDetected += summary.conflicts.length;
    summary.conflicts.forEach((conflict) => {
      allConflicts.push({ conflict });
    });
    allFailures.push(...summary.failures);
    libraryIds.add(summary.libraryId);

    const chunkPath = await writeChunkFile(chunkDir, summary.libraryId, chunkIndex, batch);
    if (chunkPath) {
      chunkRecords.push({ path: chunkPath, libraryId: summary.libraryId });
    }
  }

  if (firstPassLines === 0 || chunkRecords.length === 0) {
    throw new Error('No log lines found in input file.');
  }

  const replayStats = await replayMatchPhase({
    chunkRecords,
    templateManager,
    regexWorkerPool,
    reportPath,
  });
  options.observer?.onBatchProgress?.({
    current: chunkIndex,
    total: chunkRecords.length,
  });

  const templateLibraryPaths = [...libraryIds].map((id) =>
    getLibraryDatabasePath(templateLibraryDir, id),
  );

  if (allFailures.length > 0) {
    await writeFailureReport(failureLogPath, allFailures);
  }

  const conflictReportPath = join(reportDir, `${runId}-conflicts.json`);
  if (conflictsDetected > 0) {
    await writeConflictReport(conflictReportPath, allConflicts);
  }

  return {
    runId,
    totalLines: replayStats.totalLines,
    matched: replayStats.matched,
    unmatched: replayStats.unmatched,
    templatesUpdated,
    conflictsDetected,
    templateLibraryPaths,
    reportPath,
    chunkDirectory: chunkDir,
    conflictReportPath: conflictsDetected > 0 ? conflictReportPath : undefined,
    failureReportPath: allFailures.length > 0 ? failureLogPath : undefined,
  };
}

function createDefaultAgents(llmClient: LlmClient): {
  routing: RoutingAgent;
  parsing: ParsingAgent;
  refine: RefineAgent;
  head: HeadAgent;
} {
  return {
    routing: new RoutingAgent({ llmClient }),
    parsing: new ParsingAgent({ llmClient }),
    refine: new RefineAgent({ llmClient }),
    head: new HeadAgent({ llmClient }),
  };
}
