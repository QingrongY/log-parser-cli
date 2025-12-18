/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';

export interface RunnerOptions {
  inputPath: string;
  limit?: number;
  batchSize?: number;
  outputDir: string;
  sourceHint?: string;
  interactive?: boolean;
  matchOnly?: boolean;
  libraryId?: string;
  skipThreshold?: number;
}

export const parseArgs = (argv: string[]): RunnerOptions => {
  const benchRoot = 'benchmark';
  const options: RunnerOptions = {
    inputPath: '',
    outputDir: resolve(process.cwd(), `${benchRoot}/log-parser`),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
      case '-i':
        options.inputPath = argv[++i];
        break;
      case '--limit':
      case '-n':
        options.limit = Number(argv[++i]);
        break;
      case '--batch-size':
        options.batchSize = Number(argv[++i]);
        break;
      case '--output':
      case '-o':
        options.outputDir = resolve(argv[++i]);
        break;
      case '--source-hint':
        options.sourceHint = argv[++i];
        break;
      case '--interactive':
        options.interactive = true;
        break;
      case '--match-only':
        options.matchOnly = true;
        break;
      case '--library':
        options.libraryId = argv[++i];
        break;
      case '--skip-threshold':
        options.skipThreshold = Number(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};
