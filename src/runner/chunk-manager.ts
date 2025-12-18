/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes a batch of log lines to a chunk file for later replay.
 *
 * @param baseDirectory - Base directory for chunk storage
 * @param libraryId - ID of the template library
 * @param index - Chunk index for ordering
 * @param lines - Log lines to write
 * @returns Path to the created chunk file, or undefined if no lines
 */
export async function writeChunkFile(
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

/**
 * Reads all non-empty lines from a chunk file.
 *
 * @param filePath - Path to the chunk file
 * @returns Array of log lines
 */
export async function readChunkLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
