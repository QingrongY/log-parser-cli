/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { TemplateConflict, FailureRecord } from '../core/types.js';

/**
 * Writes a conflict report to a JSON file.
 *
 * @param path - Output file path
 * @param conflicts - Array of conflicts with line indices
 */
export async function writeConflictReport(
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

/**
 * Writes a failure report to a JSON file.
 *
 * @param path - Output file path
 * @param failures - Array of failure records
 */
export async function writeFailureReport(
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
