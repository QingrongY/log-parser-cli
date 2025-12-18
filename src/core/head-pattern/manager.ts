/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HeadAgent, HeadPatternDefinition, AgentContext } from '../../agents/index.js';
import type { ProcessingObserver } from '../../types/observer.js';
import type { TemplateLibrary, TemplateManager } from '../types.js';
import type { RegexLogEntry } from '../regex-worker-pool.js';
import { selectDiverseSamples } from '../diverse-sampler.js';
import { extractContentWithHead } from '../head-pattern.js';

export interface HeadPatternManagerOptions {
  headAgent?: HeadAgent;
  templateManager: TemplateManager;
  observer?: ProcessingObserver;
}

/**
 * Manages head pattern derivation, refinement, and validation.
 * Extracted from LogProcessingPipeline for better separation of concerns.
 */
export class HeadPatternManager {
  constructor(private readonly options: HeadPatternManagerOptions) {}

  /**
   * Ensures a head pattern exists for the given library, deriving and refining it if needed.
   */
  async ensureHeadPattern(params: {
    logs: string[];
    libraryId: string;
    library: TemplateLibrary;
    context: AgentContext;
  }): Promise<HeadPatternDefinition | undefined> {
    const headAgent = this.options.headAgent;
    let current = params.library.headPattern;
    const seedSamples: string[] = [];
    const sampleAccumulator: string[] = [];
    const seenSamples = new Set<string>();

    // Try deriving an initial head regex if none exists and the agent is available.
    if (!current && headAgent) {
      const samples = selectDiverseSamples(params.logs, 10, params.logs.length);
      seedSamples.push(...samples);
      sampleAccumulator.push(...samples);
      samples.forEach((s) => seenSamples.add(s));
      if (samples.length > 0) {
        this.logStage(-1, 'head', `deriving head regex (initial, samples=${samples.length})`);
        const result = await headAgent.run({ samples, newSamples: samples }, params.context);
        if (result.status === 'success' && result.output?.pattern) {
          current = result.output;
          params.library.headPattern = current;
          if (this.options.templateManager.saveHeadPattern) {
            await this.options.templateManager.saveHeadPattern(params.libraryId, current);
          }
          console.log(`[log-parser] head regex (initial): ${current.pattern}`);
          this.options.observer?.onStage?.({
            stage: 'head',
            message: 'derived head regex',
            data: { pattern: current.pattern },
          });
        } else {
          console.warn('[log-parser] head initial derivation failed');
        }
      }
    } else if (!seedSamples.length) {
      // If head already exists (from cache), still keep a stable seed from the dataset.
      const samples = selectDiverseSamples(params.logs, 10, params.logs.length);
      seedSamples.push(...samples);
      sampleAccumulator.push(...samples);
      samples.forEach((s) => seenSamples.add(s));
    }

    if (!current) {
      return undefined;
    }

    // Validate coverage on the current batch; iteratively refine with unmatched samples if needed.
    const maxRefineRounds = 10;

    const attemptRefine = async (
      pattern: HeadPatternDefinition,
    ): Promise<{ pattern: HeadPatternDefinition; unmatched: string[] }> => {
      const coverage = this.evaluateCoverage(params.logs, pattern);
      return { pattern, unmatched: coverage.unmatched };
    };

    let state = await attemptRefine(current);
    let bestState = state;
    let bestPattern = current;
    this.logStage(
      -1,
      'head',
      `head coverage check: unmatched=${state.unmatched.length}/${params.logs.length}`,
    );
    if (!headAgent && state.unmatched.length > 0) {
      console.warn('[log-parser] head refine skipped (no head agent configured)');
    }

    for (let round = 0; round < maxRefineRounds && state.unmatched.length > 0; round += 1) {
      if (!headAgent) {
        break;
      }
      // Add incremental unmatched samples (3 per round) to the accumulated pool.
      const available = state.unmatched.filter((line) => !seenSamples.has(line));
      const newPicks = selectDiverseSamples(available, Math.min(3, available.length), available.length);
      for (const line of newPicks) {
        if (!seenSamples.has(line)) {
          seenSamples.add(line);
          sampleAccumulator.push(line);
        }
      }
      const refineSamples = [...sampleAccumulator];
      if (refineSamples.length === 0) {
        break;
      }
      this.logStage(
        -1,
        'head',
        `refining head regex (round ${round + 1}, unmatched=${state.unmatched.length}, samples=${refineSamples.length})`,
      );
      console.log(
        `[log-parser] head refine round ${round + 1}: unmatched=${state.unmatched.length}, samples=${refineSamples.length}`,
      );
      const result = await headAgent.run(
        { samples: refineSamples, newSamples: newPicks, previousPattern: current.pattern },
        params.context,
      );
      if (result.status !== 'success' || !result.output?.pattern) {
        console.warn(`[log-parser] head refine round ${round + 1} failed status=${result.status}`);
        break;
      }
      console.log(`[log-parser] head regex (candidate round ${round + 1}): ${result.output.pattern}`);
      const next = await attemptRefine(result.output);
      this.logStage(
        -1,
        'head',
        `head candidate evaluated (round ${round + 1}): unmatched=${next.unmatched.length}/${params.logs.length}`,
      );
      console.log(
        `[log-parser] head candidate round ${round + 1}: unmatched=${next.unmatched.length}/${params.logs.length}`,
      );
      if (next.unmatched.length <= bestState.unmatched.length) {
        bestState = next;
        bestPattern = next.pattern;
        current = next.pattern;
        params.library.headPattern = current;
        if (this.options.templateManager.saveHeadPattern) {
          await this.options.templateManager.saveHeadPattern(params.libraryId, current);
        }
        this.options.observer?.onStage?.({
          stage: 'head',
          message: 'refined head regex',
          data: {
            pattern: current.pattern,
            unmatchedSamples: next.unmatched.length,
          },
        });
        console.log(
          `[log-parser] head refined round ${round + 1}: unmatched now ${next.unmatched.length}/${params.logs.length}`,
        );
      } else {
        console.log(
          `[log-parser] head candidate rejected (round ${round + 1}): no improvement (${next.unmatched.length}/${params.logs.length})`,
        );
      }
      state = bestState;
    }

    // Persist best pattern after all rounds.
    if (bestPattern && this.options.templateManager.saveHeadPattern) {
      await this.options.templateManager.saveHeadPattern(params.libraryId, bestPattern);
    }

    if (bestState.unmatched.length > 0) {
      this.options.observer?.onStage?.({
        stage: 'head',
        message: 'head regex did not cover all logs',
        data: { unmatchedCount: bestState.unmatched.length },
      });
      this.logStage(
        -1,
        'head',
        `head regex did not cover ${bestState.unmatched.length} log(s)`,
        { unmatchedCount: bestState.unmatched.length },
      );
      console.error(
        `[log-parser] head regex did not cover ${bestState.unmatched.length}/${params.logs.length} logs; pattern=${bestPattern.pattern}`,
      );
    }

    return bestPattern;
  }

  /**
   * Creates log entries with head pattern extraction applied.
   */
  createEntriesWithHead(
    logs: string[],
    headPattern?: HeadPatternDefinition,
  ): RegexLogEntry[] {
    let compiled: RegExp | undefined;
    if (headPattern?.pattern) {
      try {
        compiled = new RegExp(headPattern.pattern);
      } catch {
        compiled = undefined;
      }
    }
    return logs.map((raw, index) => {
      const entry: RegexLogEntry = { raw, index };
      if (compiled) {
        const extraction = extractContentWithHead(raw, headPattern, compiled);
        if (extraction.matched) {
          entry.content = extraction.content;
          entry.headMatched = true;
        } else {
          // If head doesn't match, treat as failure to extract content.
          entry.headMatched = false;
          entry.content = undefined;
        }
      }
      return entry;
    });
  }

  /**
   * Evaluates how well a head pattern covers the given logs.
   */
  evaluateCoverage(
    logs: string[],
    headPattern: HeadPatternDefinition,
  ): { unmatched: string[] } {
    if (!headPattern?.pattern) {
      return { unmatched: logs };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(headPattern.pattern);
    } catch {
      return { unmatched: logs };
    }
    const unmatched: string[] = [];
    for (const line of logs) {
      if (!regex.exec(line)) {
        unmatched.push(line);
      }
    }
    return { unmatched };
  }

  /**
   * Extracts content from a log entry based on head pattern.
   */
  getContent(entry: RegexLogEntry, headPattern?: HeadPatternDefinition): string | undefined {
    if (headPattern?.pattern) {
      return entry.content;
    }
    return entry.raw;
  }

  /**
   * Extracts content from a raw log string.
   */
  getContentFromRaw(raw: string, headPattern?: HeadPatternDefinition): string | undefined {
    if (!headPattern?.pattern) {
      return raw;
    }
    const extraction = extractContentWithHead(raw, headPattern);
    if (!extraction.matched) {
      return undefined;
    }
    return extraction.content;
  }

  private logStage(
    lineIndex: number,
    stage: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.options.observer?.onStage?.({ stage, message, data });
  }
}
