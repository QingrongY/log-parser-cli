/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  ParsingAgent,
  RoutingAgent,
  RefineAgent,
  type LlmClient,
} from '../agents/index.js';
import {
  LogProcessingPipeline,
  RegexWorkerPool,
  type MatchedLogRecord,
  type TemplateLibrary,
  type TemplateManager,
  type ProcessingObserver,
} from '../core/index.js';
import {
  SqliteTemplateManager,
  writeMatchReport,
  getLibraryDatabasePath,
} from '../tools/index.js';
import type { TemplateConflict, FailureRecord } from '../core/types.js';

async function writeConflictReport(
  path: string,
  conflicts: Array<{ lineIndex?: number; conflict: TemplateConflict }>,
): Promise<void> {
  const report = {
    timestamp: new Date().toISOString(),
    totalConflicts: conflicts.length,
    conflicts: conflicts.map(({ lineIndex, conflict }) => ({
      lineIndex,
      candidate: conflict.candidate,
      conflictsWith: conflict.conflictsWith,
      diagnostics: conflict.diagnostics,
    })),
  };
  await fs.writeFile(path, JSON.stringify(report, null, 2), 'utf-8');
}

async function writeFailureReport(
  path: string,
  failures: FailureRecord[],
): Promise<void> {
  const report = {
    timestamp: new Date().toISOString(),
    totalFailures: failures.length,
    failures: failures.map((f) => ({
      lineIndex: f.lineIndex,
      rawLog: f.rawLog,
      stage: f.stage,
      reason: f.reason,
      timestamp: f.timestamp,
      details: f.details,
    })),
  };
  await fs.writeFile(path, JSON.stringify(report, null, 2), 'utf-8');
}

export interface SemanticLogParserOptions {
  inputPath: string;
  outputDir: string;
  llmClient?: LlmClient;
  limit?: number;
  variableHints?: string[];
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

export async function runSemanticLogParser(
  options: SemanticLogParserOptions,
): Promise<SemanticLogParserResult> {
  const runId = options.runId ?? randomUUID();
  const variableHints = options.variableHints ?? [];
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
      variableHints,
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
} {
  return {
    routing: new RoutingAgent({ llmClient }),
    parsing: new ParsingAgent({ llmClient }),
    refine: new RefineAgent({ llmClient }),
  };
}

async function* streamLogBatches(
  filePath: string,
  batchSize: number,
  limit?: number,
): AsyncGenerator<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let batch: string[] = [];
  let count = 0;
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trimEnd();
      if (line.length === 0) {
        continue;
      }
      batch.push(line);
      count += 1;
      if (batch.length === batchSize) {
        yield batch;
        batch = [];
      }
      if (typeof limit === 'number' && limit > 0 && count >= limit) {
        break;
      }
    }
    if (batch.length > 0) {
      yield batch;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

async function writeChunkFile(
  baseDirectory: string,
  libraryId: string,
  index: number,
  lines: string[],
): Promise<string | undefined> {
  if (!lines.length) {
    return undefined;
  }
  const targetDir = join(baseDirectory, libraryId);
  await fs.mkdir(targetDir, { recursive: true });
  const fileName = `chunk-${String(index).padStart(5, '0')}.log`;
  const filePath = join(targetDir, fileName);
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

async function estimateBatchTotal(
  filePath: string,
  batchSize: number,
  limit?: number,
): Promise<number | undefined> {
  if (typeof limit === 'number' && limit > 0) {
    return Math.ceil(limit / batchSize);
  }
  const totalLines = await countLogLines(filePath);
  if (totalLines === 0) {
    return undefined;
  }
  return Math.ceil(totalLines / batchSize);
}

async function countLogLines(filePath: string): Promise<number> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let count = 0;
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trimEnd();
      if (line.length === 0) {
        continue;
      }
      count += 1;
    }
  } finally {
    rl.close();
    stream.close();
  }
  return count;
}

interface ReplayStats {
  totalLines: number;
  matched: number;
  unmatched: number;
}

interface ChunkRecord {
  path: string;
  libraryId: string;
}

interface ReplayParams {
  chunkRecords: ChunkRecord[];
  templateManager: TemplateManager;
  regexWorkerPool: RegexWorkerPool;
  reportPath: string;
}

async function replayMatchPhase({
  chunkRecords,
  templateManager,
  regexWorkerPool,
  reportPath,
}: ReplayParams): Promise<ReplayStats> {
  let totalLines = 0;
  let matched = 0;
  let unmatched = 0;
  let reportInitialized = false;
  let globalLineIndex = 0;
  const libraryCache = new Map<string, TemplateLibrary>();

  for (const record of chunkRecords) {
    const lines = await readChunkLines(record.path);
    if (lines.length === 0) {
      continue;
    }

    totalLines += lines.length;
    const entries = lines.map((raw) => ({
      raw,
      index: globalLineIndex++,
    }));

    let library = libraryCache.get(record.libraryId);
    if (!library) {
      library = await templateManager.loadLibrary(record.libraryId);
      libraryCache.set(record.libraryId, library);
    }
    const templates = library.templates;
    const result =
      templates.length === 0
        ? { matched: [] as MatchedLogRecord[], unmatched: entries }
        : await regexWorkerPool.match({
            logs: entries,
            templates,
          });

    matched += result.matched.length;
    unmatched += result.unmatched.length;

    if (result.matched.length > 0) {
      await writeMatchReport(result.matched, {
        filePath: reportPath,
        append: reportInitialized,
        includeHeader: !reportInitialized,
      });
      reportInitialized = true;
      await templateManager.recordMatches(record.libraryId, result.matched);
    }
  }

  if (!reportInitialized) {
    await writeMatchReport([], { filePath: reportPath });
  }

  return { totalLines, matched, unmatched };
}

async function readChunkLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
