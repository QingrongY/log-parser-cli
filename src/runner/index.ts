/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  runSemanticLogParser,
  type SemanticLogParserOptions,
  type SemanticLogParserResult,
} from './semantic-log-parser.js';

export {
  streamLogBatches,
  estimateBatchTotal,
  countLogLines,
} from './batch-processor.js';

export {
  writeChunkFile,
  readChunkLines,
} from './chunk-manager.js';

export {
  writeConflictReport,
  writeFailureReport,
} from './report-writers.js';

export {
  replayMatchPhase,
  type ReplayStats,
  type ChunkRecord,
  type ReplayMatcherOptions,
} from './replay-matcher.js';
