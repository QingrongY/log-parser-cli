#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink';
import type { SemanticLogParserOptions } from '../runner/index.js';
import { LogParserApp } from './log-parser-app.js';
import { parseArgs, type RunnerOptions } from './args.js';
import { runInteractiveSetup } from './interactive.js';
import { resolveLlmConfigFromEnv, createLlmClient } from '../llm/config.js';

export const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const streamingBatchSize = options.batchSize ?? 50_000;

  if (options.interactive) {
    await runInteractiveSetup(options);
  }

  if (!options.inputPath) {
    throw new Error('Missing --input <path> argument.');
  }

  const llmConfig = resolveLlmConfigFromEnv();
  const llmClient = options.matchOnly ? undefined : createLlmClient(llmConfig);
  if (!options.matchOnly && !llmClient) {
    console.error(
      '[log-parser] LLM client not configured. Set AIMLAPI_API_KEY (preferred) or GEMINI_API_KEY before running.',
    );
    process.exit(1);
  }
  if (options.matchOnly && !options.libraryId) {
    console.error('[log-parser] --match-only requires --library <templateLibraryId>.');
    process.exit(1);
  }

  const semanticOptions: SemanticLogParserOptions = {
    inputPath: options.inputPath,
    outputDir: options.outputDir,
    llmClient,
    limit: options.limit,
    batchSize: streamingBatchSize,
    sourceHint: options.sourceHint,
    matchOnly: options.matchOnly,
    libraryId: options.libraryId,
    skipThreshold: options.skipThreshold,
  };

  const { waitUntilExit } = render(<LogParserApp options={semanticOptions} />);
  await waitUntilExit();
};

if (process.argv[1] && process.argv[1].includes('cli')) {
  main().catch((error) => {
    console.error('Failed to run log parser:', error);
    process.exit(1);
  });
}
