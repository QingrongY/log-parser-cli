/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface ReadLogOptions {
  limit?: number;
  skipEmpty?: boolean;
}

export const readLogLines = async (
  filePath: string,
  options: ReadLogOptions = {},
): Promise<string[]> => {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => (options.skipEmpty ?? true ? line.length > 0 : true));
  if (typeof options.limit === 'number' && options.limit >= 0) {
    return lines.slice(0, options.limit);
  }
  return lines;
};

export const ensureDirectory = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const writeJsonFile = async (filePath: string, data: unknown): Promise<void> => {
  await ensureDirectory(dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

export const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const buffer = await fs.readFile(filePath, 'utf8');
  return JSON.parse(buffer) as T;
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};
