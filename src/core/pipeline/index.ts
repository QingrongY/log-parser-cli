/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  LogProcessingPipeline,
  type LogProcessingPipelineDeps,
} from './pipeline.js';

// Re-export observer types for convenience
export type { ProcessingObserver, StageEvent } from '../../types/observer.js';
