/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream } from 'node:fs';
import readline from 'node:readline';

/**
 * Streams log file in batches for efficient processing of large files.
 *
 * @param filePath - Path to the log file
 * @param batchSize - Number of lines per batch
 * @param limit - Optional maximum number of lines to process
 * @yields Batches of log lines
 */
export async function* streamLogBatches(
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

/**
 * Estimates the total number of batches for progress tracking.
 *
 * @param filePath - Path to the log file
 * @param batchSize - Number of lines per batch
 * @param limit - Optional line limit
 * @returns Estimated batch count or undefined if cannot determine
 */
export async function estimateBatchTotal(
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

/**
 * Counts non-empty lines in a log file.
 *
 * @param filePath - Path to the log file
 * @returns Total number of non-empty lines
 */
export async function countLogLines(filePath: string): Promise<number> {
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
