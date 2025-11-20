/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ensureDirectory } from './io/files.js';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { MatchedLogRecord } from '../core/index.js';

export interface MatchReportOptions {
  filePath: string;
  delimiter?: string;
  append?: boolean;
  includeHeader?: boolean;
}

export const writeMatchReport = async (
  records: MatchedLogRecord[],
  options: MatchReportOptions,
): Promise<void> => {
  const delimiter = options.delimiter ?? ',';
  const header = ['raw_log', 'template_id', 'template_pattern', 'variables'];
  const rows = records.map((record) => [
    record.raw,
    record.template.id ?? '',
    record.template.pattern,
    JSON.stringify(record.variables ?? {}),
  ]);
  const formattedRows = rows.map((columns) =>
    columns.map((value) => formatCsvValue(value, delimiter)).join(delimiter),
  );
  const includeHeader = options.includeHeader ?? !options.append;
  const outputLines = includeHeader
    ? [header.map((value) => formatCsvValue(value, delimiter)).join(delimiter), ...formattedRows]
    : formattedRows;
  if (outputLines.length === 0) {
    if (!options.append) {
      await ensureDirectory(dirname(options.filePath));
      await fs.writeFile(options.filePath, '', 'utf8');
    }
    return;
  }
  let serialized = outputLines.join('\n');
  if (options.append && !includeHeader) {
    serialized = `\n${serialized}`;
  }
  await ensureDirectory(dirname(options.filePath));
  if (options.append) {
    await fs.appendFile(options.filePath, serialized, 'utf8');
  } else {
    await fs.writeFile(options.filePath, serialized, 'utf8');
  }
};

const formatCsvValue = (value: string, delimiter: string): string => {
  if (value === undefined || value === null) {
    return '';
  }
  const needsQuoting =
    value.includes(delimiter) || value.includes('\n') || value.includes('"') || value.includes("'");
  if (!needsQuoting) {
    return value;
  }
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
};
