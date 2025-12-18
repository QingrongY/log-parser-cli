/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import type { SemanticLogParserOptions, SemanticLogParserResult } from '../runner/index.js';
import { runSemanticLogParser } from '../runner/index.js';
import type { ProcessingObserver } from '../core/index.js';

interface Stats {
  matched: number;
  pending: number;
  failed: number;
  templates: number;
}

interface Progress {
  currentLine: number;
  totalLines: number;
  currentBatch: number;
  totalBatches: number;
}

interface AppState {
  source: string;
  library: string;
  stats: Stats;
  progress: Progress;
  lastEvent: string;
  isComplete: boolean;
}

const initialState: AppState = {
  source: '...',
  library: '...',
  stats: { matched: 0, pending: 0, failed: 0, templates: 0 },
  progress: { currentLine: 0, totalLines: 0, currentBatch: 0, totalBatches: 0 },
  lastEvent: 'Initializing...',
  isComplete: false,
};

export interface LogParserAppProps {
  options: SemanticLogParserOptions;
}

export const LogParserApp: React.FC<LogParserAppProps> = ({ options }) => {
  const [state, setState] = useState<AppState>(initialState);
  const [result, setResult] = useState<SemanticLogParserResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const { exit } = useApp();

  useEffect(() => {
    let cancelled = false;

    const observer: ProcessingObserver = {
      onBatchProgress: (info) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          progress: {
            ...prev.progress,
            currentBatch: info.current,
            totalBatches: info.total ?? prev.progress.totalBatches,
          },
          lastEvent: `Processing batch ${info.current}/${info.total ?? '?'}`,
        }));
      },

      onRouting: (info) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          source: info.source,
          library: info.libraryId,
          stats: { ...prev.stats, templates: info.existingTemplates },
          lastEvent: `Routed to library: ${info.libraryId}`,
        }));
      },

      onExistingMatchSummary: (info) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          stats: {
            ...prev.stats,
            matched: prev.stats.matched + info.matched,
            pending: prev.stats.pending + info.unmatched,
          },
          lastEvent: `Loaded ${info.matched} existing matches, ${info.unmatched} pending`,
        }));
      },

      onStage: (event) => {
        if (cancelled) return;
        if (event.lineIndex === undefined) return;

        const lineIndex = event.lineIndex;

        setState((prev) => {
          const newStats = { ...prev.stats };
          if (event.stage === 'update' && event.data?.action === 'added') {
            newStats.templates += 1;
          }
          return {
            ...prev,
            progress: { ...prev.progress, currentLine: lineIndex + 1 },
            stats: newStats,
            lastEvent: `[${event.stage}] ${event.message}`,
          };
        });
      },

      onMatching: (info) => {
        if (cancelled) return;
        if (info.lineIndex === undefined) return;

        const lineIndex = info.lineIndex;

        setState((prev) => {
          const newStats = { ...prev.stats };
          newStats.matched += info.matched;
          newStats.pending = Math.max(0, newStats.pending - info.matched);
          return {
            ...prev,
            progress: { ...prev.progress, currentLine: lineIndex + 1 },
            stats: newStats,
            lastEvent: `Matched ${info.matched} log(s)`,
          };
        });
      },

      onFailure: (failure) => {
        if (cancelled) return;
        const lineIndex = failure.lineIndex;

        setState((prev) => {
          const newStats = { ...prev.stats };
          newStats.failed += 1;
          newStats.pending = Math.max(0, newStats.pending - 1);
          return {
            ...prev,
            progress: { ...prev.progress, currentLine: lineIndex + 1 },
            stats: newStats,
            lastEvent: `[failure] ${failure.stage}: ${failure.reason}`,
          };
        });
      },
    };

    runSemanticLogParser({ ...options, observer })
      .then((res) => {
        if (cancelled) return;
        setResult(res);
        setState((prev) => ({
          ...prev,
          progress: { ...prev.progress, totalLines: res.totalLines },
          isComplete: true,
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [options]);

  useEffect(() => {
    if (result || error) {
      const timer = setTimeout(() => exit(error ? new Error(error) : undefined), 200);
      return () => clearTimeout(timer);
    }
  }, [result, error, exit]);

  const progressPercent = calculateProgress(state.stats);
  const progressBar = renderBar(progressPercent, 30);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyanBright">
          LOG PARSER
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1} paddingY={0}>
        <Box>
          <Text dimColor>Source: </Text>
          <Text color="white">{state.source}</Text>
          <Text dimColor> | Library: </Text>
          <Text color="cyan">{state.library}</Text>
          <Text dimColor> | Batch: </Text>
          <Text>
            {state.progress.currentBatch}/{state.progress.totalBatches || '?'}
          </Text>
          <Text dimColor> | Line: </Text>
          <Text>
            {state.progress.currentLine}
            {state.progress.totalLines > 0 ? ` / ${state.progress.totalLines}` : ''}
          </Text>
        </Box>
        <Box>
          <Text dimColor>Matched: </Text>
          <Text color="greenBright">{state.stats.matched}</Text>
          <Text dimColor> | Pending: </Text>
          <Text color="yellow">{state.stats.pending}</Text>
          <Text dimColor> | Failed: </Text>
          <Text color="red">{state.stats.failed}</Text>
          <Text dimColor> | Templates: </Text>
          <Text color="cyan">{state.stats.templates}</Text>
        </Box>
        <Box>
          <Text dimColor>Progress: </Text>
          <Text color="greenBright">{progressBar}</Text>
          <Text color="white"> {progressPercent}%</Text>
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="magenta" paddingX={1} paddingY={0}>
        <Text bold color="magenta">
          Activity:{' '}
        </Text>
        <Text>{state.lastEvent}</Text>
      </Box>

      {result && (
        <Box marginTop={1} borderStyle="double" borderColor="greenBright" flexDirection="column" paddingX={1} paddingY={0}>
          <Text bold color="greenBright">
            ✓ COMPLETE
          </Text>
          <Text>
            Run ID: <Text color="cyan">{result.runId}</Text>
          </Text>
          <Text>
            Processed {result.totalLines} lines | Matched {result.matched} | Unmatched {result.unmatched}
          </Text>
          <Text>Templates Updated: {result.templatesUpdated}</Text>
          {result.conflictsDetected > 0 && (
            <Text color="yellow">
              Conflicts: {result.conflictsDetected} (see {result.conflictReportPath})
            </Text>
          )}
          {result.failureReportPath && (
            <Text color="red">
              Failure details: {result.failureReportPath}
            </Text>
          )}
          <Text dimColor>Match report: {result.reportPath}</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1} borderStyle="bold" borderColor="red" paddingX={1} paddingY={0}>
          <Text color="redBright">ERROR: {error}</Text>
        </Box>
      )}
    </Box>
  );
};

function calculateProgress(stats: Stats): number {
  const total = stats.matched + stats.pending + stats.failed;
  if (total === 0) return 0;
  return Math.round((stats.matched / total) * 100);
}

function renderBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
