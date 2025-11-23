/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import type { SemanticLogParserOptions, SemanticLogParserResult } from '../runner/index.js';
import { runSemanticLogParser } from '../runner/index.js';
import type { ProcessingObserver } from '../core/index.js';

const STAGES = ['routing', 'parsing', 'validation', 'repair', 'update', 'matching'] as const;

type StageName = typeof STAGES[number];

interface StageState {
  message: string;
  lineIndex?: number;
}

interface UiState {
  currentLine?: number;
  matched: number;
  pending: number;
  initialLearning?: number;
  failed: number;
  templates: number;
  stageMessages: Record<StageName, StageState>;
  events: string[];
  library?: string;
  source?: string;
  batchIndex: number;
  totalBatches?: number;
}

const initialStageState: Record<StageName, StageState> = STAGES.reduce(
  (acc, stage) => {
    acc[stage] = { message: 'idle' };
    return acc;
  },
  {} as Record<StageName, StageState>,
);

const MAX_EVENTS = 6;

export interface LogParserAppProps {
  options: SemanticLogParserOptions;
}

export const LogParserApp: React.FC<LogParserAppProps> = ({ options }) => {
  const [state, setState] = useState<UiState>({
    matched: 0,
    pending: 0,
    initialLearning: undefined,
    failed: 0,
    templates: 0,
    stageMessages: initialStageState,
    events: [],
    batchIndex: 0,
    totalBatches: undefined,
  });
  const [summary, setSummary] = useState<SemanticLogParserResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const { exit } = useApp();

  useEffect(() => {
    let cancelled = false;
    const observer: ProcessingObserver = {
      onBatchProgress: (info) => {
        if (cancelled) {
          return;
        }
        setState((prev) => ({
          ...prev,
          batchIndex: info.current,
          totalBatches: info.total ?? prev.totalBatches,
        }));
      },
      onRouting: (info) => {
        if (cancelled) {
          return;
        }
        setState((prev) => ({
          ...prev,
          library: info.libraryId,
          source: info.source,
          stageMessages: {
            ...prev.stageMessages,
            routing: { message: `library=${info.libraryId}`, lineIndex: undefined },
          },
          events: pushEvent(prev.events, `routing -> library=${info.libraryId}`),
        }));
      },
      onExistingMatchSummary: (info) => {
        if (cancelled) {
          return;
        }
        setState((prev) => ({
          ...prev,
          matched: info.matched,
          pending: info.unmatched,
          initialLearning:
            typeof prev.initialLearning === 'number' ? prev.initialLearning : info.unmatched,
          failed: 0,
        }));
      },
      onStage: (event) => {
        if (cancelled) {
          return;
        }
        setState((prev) => {
          const nextStage = { ...prev.stageMessages[event.stage as StageName] };
          nextStage.message = event.message;
          nextStage.lineIndex = event.lineIndex;
          const newStages: Record<StageName, StageState> = {
            ...prev.stageMessages,
            [event.stage as StageName]: nextStage,
          };
          let templates = prev.templates;
          if (
            event.stage === 'update' &&
            event.data &&
            typeof event.data['action'] === 'string' &&
            (event.data['action'] === 'added' || event.data['action'] === 'updated')
          ) {
            templates += 1;
          }
          let failed = prev.failed;
          let pending = prev.pending;
          if (isFailureEvent(event.stage as StageName, event.message, event.lineIndex)) {
            failed += 1;
            pending = Math.max(0, pending - 1); // remove from pending on failure to match pipeline behavior
          }
          const lineLabel =
            typeof event.lineIndex === 'number' ? `line ${event.lineIndex + 1}` : 'global';
          return {
            ...prev,
            currentLine: event.lineIndex,
            stageMessages: newStages,
            templates,
            pending,
            failed,
            events: pushEvent(prev.events, `${lineLabel}: ${event.stage} -> ${event.message}`),
          };
        });
      },
      onMatching: (info) => {
        if (cancelled) {
          return;
        }
        setState((prev) => ({
          ...prev,
          currentLine: info.lineIndex,
          matched: prev.matched + info.matched,
          pending: Math.max(prev.pending - info.matched, 0),
          events: pushEvent(
            prev.events,
            `matching -> +${info.matched} (total ${prev.matched + info.matched})`,
          ),
        }));
      },
    };

    runSemanticLogParser({
      ...options,
      observer,
    })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setSummary(result);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [options]);

  useEffect(() => {
    if (summary || error) {
      const timer = setTimeout(() => exit(error ? new Error(error) : undefined), 200);
      return () => clearTimeout(timer);
    }
    return;
  }, [summary, error, exit]);

  const learningTarget = state.initialLearning ?? 0;
  const resolvedLearning =
    learningTarget > 0 ? Math.max(0, learningTarget - state.pending) : state.pending === 0 ? 1 : 0;
  const progressRatio =
    learningTarget > 0 ? resolvedLearning / learningTarget : state.pending === 0 ? 1 : 0;
  const progressBar = renderProgressBar(progressRatio, 12);
  const progressLabel =
    learningTarget > 0 ? `${Math.round(progressRatio * 100)}%` : state.pending === 0 ? '100%' : '--';

  const stageRows = useMemo(
    () =>
      STAGES.map((stage) => {
        const entry = state.stageMessages[stage];
        const color = colorForMessage(stage, entry.message);
        return (
          <Text key={stage} color={color}>
            {`[${stage.padEnd(9)}]`} {entry.message}
          </Text>
        );
      }),
    [state.stageMessages],
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          Source:{' '}
          {state.source
            ? `${state.source} (${state.library ?? 'unknown'})`
            : 'analyzing samples...'}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Learning {progressBar} {progressLabel} [Line{' '}
          {typeof state.currentLine === 'number' ? state.currentLine + 1 : '--'} | Templates{' '}
          {state.templates} | Matched {state.matched} | Failed {state.failed} | Pending {state.pending} | Batch{' '}
          {state.totalBatches
            ? `${Math.min(state.batchIndex, state.totalBatches)}/${state.totalBatches}`
            : state.batchIndex > 0
              ? `${state.batchIndex}/?`
              : '0/?'}]
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text>Stages:</Text>
        {stageRows}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text>Recent events:</Text>
        {state.events.length === 0 ? (
          <Text dimColor>No events yet.</Text>
        ) : (
          state.events.map((event, index) => (
            <Text key={`${event}-${index}`}>• {event}</Text>
          ))
        )}
      </Box>
      {summary && (
        <Box marginTop={1} flexDirection="column">
          <Text color="green">Completed run {summary.runId}</Text>
          <Text>
            Matched: {summary.matched} | Unmatched: {summary.unmatched} | Templates updated:{' '}
            {summary.templatesUpdated}
          </Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
};

function pushEvent(events: string[], next: string): string[] {
  const merged = [...events, next];
  if (merged.length > MAX_EVENTS) {
    return merged.slice(merged.length - MAX_EVENTS);
  }
  return merged;
}

function colorForMessage(stage: StageName, message: string): string {
  const normalized = message.toLowerCase();
  if (stage === 'routing') {
    return 'cyan';
  }
  if (normalized.includes('fail') || normalized.includes('conflict') || normalized.includes('skipped')) {
    return 'red';
  }
  if (normalized.includes('retry')) {
    return 'yellow';
  }
  if (
    normalized.includes('derived') ||
    normalized.includes('passed') ||
    normalized.includes('action') ||
    normalized.includes('applied') ||
    normalized.includes('library=')
  ) {
    return 'green';
  }
  return 'white';
}

function renderProgressBar(ratio: number, width: number): string {
  const filledWidth = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  const filled = '█'.repeat(filledWidth);
  const empty = '░'.repeat(Math.max(width - filledWidth, 0));
  return `[${filled}${empty}]`;
}

function isFailureEvent(stage: StageName, message: string, lineIndex?: number): boolean {
  if (typeof lineIndex !== 'number') {
    return false;
  }
  const normalized = message.toLowerCase();
  if (normalized.includes('fail') || normalized.includes('conflict')) {
    return ['parsing', 'validation', 'repair', 'update'].includes(stage);
  }
  return false;
}
