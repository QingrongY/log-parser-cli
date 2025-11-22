#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import prompts from 'prompts';
import { render } from 'ink';
import type { LlmClient } from './agents/index.js';
import type { SemanticLogParserOptions } from './runner/index.js';
import { LogParserApp } from './ui/log-parser-app.js';
import { AimlApiLlmClient, GeminiLlmClient } from './llm/index.js';

const DEFAULT_LOG_PARSER_MODEL = 'google/gemini-2.0-flash';

interface RunnerOptions {
  inputPath: string;
  limit?: number;
  variableHints: string[];
  batchSize?: number;
  outputDir: string;
  sourceHint?: string;
  interactive?: boolean;
  matchOnly?: boolean;
  libraryId?: string;
  skipThreshold?: number;
}

const parseArgs = (argv: string[]): RunnerOptions => {
  const options: RunnerOptions = {
    inputPath: '',
    variableHints: [],
    outputDir: resolve(process.cwd(), 'artifacts/log-parser'),
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
      case '--hint':
        options.variableHints.push(argv[++i]);
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

async function createLogParserLlmClient(): Promise<LlmClient | undefined> {
  const model = resolveModelPreference();
  const temperature = 0;
  const maxOutputTokens = 1024;

  const aimlKey = process.env['AIMLAPI_API_KEY'];
  if (aimlKey) {
    return new AimlApiLlmClient({
      apiKey: aimlKey,
      model,
      temperature,
      maxOutputTokens,
      baseUrl: process.env['AIMLAPI_BASE_URL'],
    });
  }

  const geminiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (geminiKey) {
    return new GeminiLlmClient({
      apiKey: geminiKey,
      model,
      temperature,
      maxOutputTokens,
      apiVersion: process.env['LOG_PARSER_GEMINI_API_VERSION'] ?? 'v1beta',
    });
  }

  return undefined;
}

function resolveModelPreference(): string {
  const candidate =
    process.env['LOG_PARSER_LLM_MODEL'] ??
    process.env['LOG_PARSER_AIMLAPI_MODEL'] ??
    process.env['AIMLAPI_MODEL'] ??
    process.env['LOG_PARSER_GEMINI_MODEL'] ??
    process.env['GEMINI_MODEL'];
  const deprecated = new Set([
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ]);
  if (!candidate || deprecated.has(candidate)) {
    return DEFAULT_LOG_PARSER_MODEL;
  }
  return candidate;
}

async function runInteractiveSetup(options: RunnerOptions): Promise<void> {
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
        initial: resolveModelPreference(),
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

export const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const streamingBatchSize = options.batchSize ?? 50_000;

  if (options.interactive) {
    await runInteractiveSetup(options);
  }

  if (!options.inputPath) {
    throw new Error('Missing --input <path> argument.');
  }

  const llmClient = options.matchOnly ? undefined : await createLogParserLlmClient();
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
    variableHints: options.variableHints,
    batchSize: streamingBatchSize,
    sourceHint: options.sourceHint,
    matchOnly: options.matchOnly,
    libraryId: options.libraryId,
    skipThreshold: options.skipThreshold,
  };

  const { waitUntilExit } = render(<LogParserApp options={semanticOptions} />);
  await waitUntilExit();
};

if (process.argv[1] && process.argv[1].includes('cli.js')) {
  main().catch((error) => {
    console.error('Failed to run log parser:', error);
    process.exit(1);
  });
}
