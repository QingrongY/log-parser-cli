/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import prompts from 'prompts';
import type { RunnerOptions } from './args.js';
import { resolveModelFromEnv } from './model.js';

export async function runInteractiveSetup(options: RunnerOptions): Promise<void> {
  const responses = await prompts(
    [
      {
        type: 'text',
        name: 'inputPath',
        message: 'Path to the log file to parse',
        initial: options.inputPath,
      },
      {
        type: 'text',
        name: 'outputDir',
        message: 'Directory to store artifacts (template libraries & reports)',
        initial: options.outputDir,
      },
      {
        type: 'number',
        name: 'limit',
        message: 'Maximum number of log lines to process (leave empty for all)',
        initial: options.limit,
      },
      {
        type: 'number',
        name: 'batchSize',
        message: 'Streaming batch size',
        initial: options.batchSize ?? 50_000,
      },
      {
        type: 'text',
        name: 'sourceHint',
        message: 'Source hint (vendor/device/version) for routing agent',
        initial: options.sourceHint,
      },
      {
        type: options.matchOnly ? 'text' : null,
        name: 'libraryId',
        message: 'Template library ID to use for matching',
        initial: options.libraryId,
      },
      {
        type: 'number',
        name: 'skipThreshold',
        message: 'Skip learning when pending logs fewer than this threshold',
        initial: options.skipThreshold ?? 0,
      },
      {
        type: 'text',
        name: 'variableHints',
        message: 'BUSINESS DATA names to track (comma-separated)',
        initial: options.variableHints.join(', '),
      },
      {
        type: 'text',
        name: 'model',
        message: 'Preferred LLM model (e.g., google/gemini-2.0-flash)',
        initial: resolveModelFromEnv(),
      },
      {
        type: 'password',
        name: 'aimlApiKey',
        message: 'AimlAPI API key (recommended)',
      },
      {
        type: 'password',
        name: 'geminiApiKey',
        message: 'Direct Gemini API key (fallback)',
      },
    ],
    {
      onCancel: () => {
        console.log('Interactive setup cancelled.');
        process.exit(1);
      },
    },
  );

  if (responses.aimlApiKey) {
    process.env['AIMLAPI_API_KEY'] = responses.aimlApiKey;
  }
  if (responses.geminiApiKey) {
    process.env['GEMINI_API_KEY'] = responses.geminiApiKey;
  }
  if (responses.model) {
    process.env['LOG_PARSER_LLM_MODEL'] = responses.model;
  }
  if (responses.inputPath) {
    options.inputPath = responses.inputPath.trim();
  }
  if (responses.outputDir) {
    options.outputDir = resolve(responses.outputDir.trim());
  }
  if (typeof responses.limit === 'number' && !Number.isNaN(responses.limit)) {
    options.limit = responses.limit;
  }
  if (typeof responses.batchSize === 'number' && !Number.isNaN(responses.batchSize)) {
    options.batchSize = responses.batchSize;
  }
  if (responses.sourceHint) {
    options.sourceHint = responses.sourceHint.trim();
  }
  if (responses.libraryId) {
    options.libraryId = responses.libraryId.trim();
  }
  if (responses.variableHints) {
    options.variableHints = responses.variableHints
      .split(',')
      .map((value: string) => value.trim())
      .filter((value: string) => value.length > 0);
  }
  if (typeof responses.skipThreshold === 'number' && !Number.isNaN(responses.skipThreshold)) {
    options.skipThreshold = responses.skipThreshold;
  }
}
