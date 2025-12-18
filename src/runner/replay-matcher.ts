/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TemplateLibrary,
  TemplateManager,
  MatchedLogRecord,
} from '../core/types.js';
import { RegexWorkerPool } from '../core/regex-worker-pool.js';
import type { RegexLogEntry } from '../core/regex-worker-pool.js';
import { extractContentWithHead } from '../core/head-pattern.js';
import { writeMatchReport } from '../tools/index.js';
import { readChunkLines } from './chunk-manager.js';

export interface ReplayStats {
  totalLines: number;
  matched: number;
  unmatched: number;
}

export interface ChunkRecord {
  path: string;
  libraryId: string;
}

export interface ReplayMatcherOptions {
  chunkRecords: ChunkRecord[];
  templateManager: TemplateManager;
  regexWorkerPool: RegexWorkerPool;
  reportPath: string;
}

/**
 * Replays the matching phase across all chunk files using finalized templates.
 * This ensures accurate match counts after all template refinement is complete.
 */
export async function replayMatchPhase(options: ReplayMatcherOptions): Promise<ReplayStats> {
  const { chunkRecords, templateManager, regexWorkerPool, reportPath } = options;

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
    let library = libraryCache.get(record.libraryId);
    if (!library) {
      library = await templateManager.loadLibrary(record.libraryId);
      libraryCache.set(record.libraryId, library);
    }
    const headPattern = library.headPattern;
    let headRegex: RegExp | undefined;
    if (headPattern?.pattern) {
      try {
        headRegex = new RegExp(headPattern.pattern);
      } catch {
        headRegex = undefined;
      }
    }
    const entries: RegexLogEntry[] = lines.map((raw) => {
      const entry: RegexLogEntry = { raw, index: globalLineIndex++ };
      if (headRegex) {
        const extraction = extractContentWithHead(raw, headPattern, headRegex);
        if (extraction.matched) {
          entry.content = extraction.content;
          entry.headMatched = true;
        }
      }
      return entry;
    });
    const templates = library.templates;
    const result =
      templates.length === 0
        ? { matched: [] as MatchedLogRecord[], unmatched: entries }
        : await regexWorkerPool.match({
            logs: entries,
            templates,
            headPattern,
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
