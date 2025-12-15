/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentContext,
  ParsingAgent,
  RoutingAgent,
  RefineAgent,
  RefineAgentOutput,
  HeadPatternDefinition,
  HeadAgent,
} from '../../agents/index.js';
import type { LogTemplateDefinition } from '../../agents/index.js';
import { RegexWorkerPool } from '../workers/regex-worker-pool.js';
import type { RegexLogEntry } from '../workers/regex-worker-pool.js';
import type {
  LogProcessingOptions,
  LogProcessingSummary,
  MatchedLogRecord,
  TemplateConflict,
  TemplateLibrary,
  TemplateManager,
  FailureRecord,
} from '../types.js';
import { matchEntireLine } from '../../agents/utils/regex.js';
import { buildRegexFromTemplate } from '../../agents/agents/parsing-agent.js';
import { selectDiverseSamples } from '../utils/diverse-sampler.js';
import { extractContentWithHead } from '../utils/head-pattern.js';

interface PipelineAgents {
  routing: RoutingAgent;
  parsing: ParsingAgent;
  refine: RefineAgent;
  head?: HeadAgent;
}

export interface LogProcessingPipelineDeps {
  agents: PipelineAgents;
  templateManager: TemplateManager;
  regexWorkerPool: RegexWorkerPool;
  observer?: ProcessingObserver;
  failureLogPath?: string;
}

export interface StageEvent {
  stage: string;
  message: string;
  lineIndex?: number;
  data?: Record<string, unknown>;
}

export interface ProcessingObserver {
  onRouting?(info: { source: string; libraryId: string; existingTemplates: number }): void;
  onStage?(event: StageEvent): void;
  onMatching?(info: { lineIndex?: number; matched: number }): void;
  onExistingMatchSummary?(info: { matched: number; unmatched: number }): void;
  onBatchProgress?(info: { current: number; total?: number }): void;
  onFailure?(failure: FailureRecord): void;
  onUnmatched?(info: { samples: string[] }): void;
}

export class LogProcessingPipeline {
  constructor(private readonly deps: LogProcessingPipelineDeps) {}

  private logStage(
    lineIndex: number,
    stage: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.deps.observer?.onStage?.({ lineIndex, stage, message, data });
  }

  private failures: FailureRecord[] = [];

  private async recordFailure(
    lineIndex: number,
    rawLog: string,
    stage: string,
    reason: string,
    template?: LogTemplateDefinition,
    details?: Record<string, unknown>
  ): Promise<void> {
    const enrichedDetails = { ...(details ?? {}) };

    try {
      if (template) {
        const runtime = buildRegexFromTemplate(
          template.placeholderTemplate,
          template.placeholderVariables,
          rawLog,
        );
        const regex = new RegExp(runtime.pattern);
        const matched = regex.exec(rawLog);
        enrichedDetails.regexSource = regex.source;
        enrichedDetails.regexFlags = regex.flags;
        enrichedDetails.regexMatched = Boolean(matched);
        if (matched?.groups) {
          enrichedDetails.regexGroups = matched.groups;
        }
      }
    } catch {
      // ignore enrichment errors
    }

    const failure: FailureRecord = {
      lineIndex,
      rawLog,
      stage,
      reason,
      timestamp: new Date().toISOString(),
      template,
      details: enrichedDetails,
    };
    this.failures.push(failure);
    this.deps.observer?.onFailure?.(failure);

    if (this.deps.failureLogPath) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(this.deps.failureLogPath, JSON.stringify(failure) + '\n', 'utf-8').catch(() => {});
    }
  }

  private async recordRefineTrace(
    lineIndex: number,
    rawLog: string,
    output: RefineAgentOutput,
    conflictingTemplate?: LogTemplateDefinition,
  ): Promise<void> {
    const trace = {
      lineIndex,
      rawLog,
      stage: 'refine-trace',
      timestamp: new Date().toISOString(),
      action: output.action,
      template: {
        placeholderTemplate: output.template.placeholderTemplate,
        placeholderVariables: output.template.placeholderVariables,
        variables: output.template.variables,
      },
      conflictingTemplateId: conflictingTemplate?.id,
    };

    if (this.deps.failureLogPath) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(this.deps.failureLogPath, JSON.stringify(trace) + '\n', 'utf-8').catch(() => {});
    }
  }

  private extractLineIndex(context: AgentContext | undefined): number | undefined {
    const value = context?.metadata?.['lineIndex'];
    return typeof value === 'number' ? Number(value) : undefined;
  }

  async process(
    logs: string[],
    options: LogProcessingOptions = {},
  ): Promise<LogProcessingSummary> {
    const runId = options.runId ?? randomUUID();
    const routingResult = await this.deps.agents.routing.run(
      {
        samples: logs.slice(0, Math.min(10, logs.length)),
        existingLibraries: await this.deps.templateManager.listLibraries(),
        sourceHint: options.sourceHint,
      },
      { runId, sourceHint: options.sourceHint },
    );

    if (routingResult.status !== 'success' || !routingResult.output) {
      throw new Error('Routing agent failed to classify the log source.');
    }

    const libraryId = routingResult.output.libraryId;
    const library = await this.deps.templateManager.loadLibrary(libraryId);
    const pipelineContext: AgentContext = {
      runId,
      sourceHint: routingResult.output.source,
      templateLibraryId: libraryId,
      userPreferences: { variableHints: options.variableHints },
    };

    this.deps.observer?.onRouting?.({
      source: routingResult.output.source,
      libraryId,
      existingTemplates: library.templates.length,
    });

    const headPattern = await this.ensureHeadPattern({
      logs,
      libraryId,
      library,
      context: pipelineContext,
    });

    const initialEntries: RegexLogEntry[] = this.createEntriesWithHead(logs, headPattern);
    const matchResult = await this.deps.regexWorkerPool.match({
      logs: initialEntries,
      templates: library.templates,
      headPattern,
    });

    await this.deps.templateManager.recordMatches(libraryId, matchResult.matched);
    library.matchedSamples.push(...matchResult.matched);
    this.deps.observer?.onExistingMatchSummary?.({
      matched: matchResult.matched.length,
      unmatched: matchResult.unmatched.length,
    });

    const skipThreshold = options.skipThreshold ?? 0;
    const newTemplates: LogTemplateDefinition[] = [];
    const conflicts: TemplateConflict[] = [];
    const matchedRecords: MatchedLogRecord[] = [...matchResult.matched];
    let pendingLogs: RegexLogEntry[] = [...matchResult.unmatched];
    const unresolvedSamples: string[] = [];

    while (pendingLogs.length > 0) {
      const sample = pendingLogs.shift();
      if (!sample) {
        break;
      }
      const lineContext: AgentContext = {
        ...pipelineContext,
        metadata: {
          ...(pipelineContext.metadata ?? {}),
          lineIndex: sample.index,
        },
      };
      const remainingLogs = pendingLogs.length + 1;
      if (skipThreshold > 0 && remainingLogs <= skipThreshold) {
        this.logStage(
          sample.index,
          'update',
          `skipped remaining ${remainingLogs} log(s) (threshold ${skipThreshold})`,
        );
        unresolvedSamples.push(sample.raw);
        unresolvedSamples.push(
          ...pendingLogs.map((entry) => entry.raw),
        );
        pendingLogs = [];
        break;
      }

      const parseResult = await this.deps.agents.parsing.run(
        {
          samples: [this.selectParsingInput(sample, headPattern)],
          variableHints: options.variableHints,
        },
        lineContext,
      );
      if (parseResult.status !== 'success' || !parseResult.output) {
        this.logStage(sample.index, 'parsing', 'failed');
        await this.recordFailure(
          sample.index,
          sample.raw,
          'parsing',
          'Parsing agent failed',
          undefined,
          { issues: parseResult.issues, diagnostics: parseResult.diagnostics },
        );
        unresolvedSamples.push(sample.raw);
        continue;
      }

      let currentTemplate: LogTemplateDefinition = this.maybeAttachHeadMetadata(
        parseResult.output,
        sample,
        headPattern,
      );
      let templateAccepted = false;

      while (!templateAccepted) {
        if (
          skipThreshold > 0 &&
          pendingLogs.length + (sample ? 1 : 0) <= skipThreshold
        ) {
          unresolvedSamples.push(sample.raw);
          this.logStage(sample.index, 'update', `skipped due to threshold ${skipThreshold}`);
          break;
        }
        const isValid = await this.validateTemplateMatch(
          currentTemplate,
          sample,
          sample.index,
          headPattern,
        );

        if (!isValid) {
          unresolvedSamples.push(sample.raw);
          break;
        }

        const validatedTemplate = currentTemplate;
        const detectedConflicts = this.findConflicts(validatedTemplate, library, headPattern);

        if (detectedConflicts.length === 0) {
          this.logStage(sample.index, 'update', 'added new template', { action: 'added' });

          const savedTemplate = await this.persistTemplate(library, libraryId, {
            action: 'added',
            template: validatedTemplate,
          });
          const postTemplate = savedTemplate ?? validatedTemplate;
          newTemplates.push(postTemplate);

          const sampleMatch = await this.deps.regexWorkerPool.match({
            logs: [sample],
            templates: [postTemplate],
            headPattern,
          });

          const allMatches: MatchedLogRecord[] = [...sampleMatch.matched];
          let newlyMatchedCount = sampleMatch.matched.length;

          if (pendingLogs.length > 0) {
            const rematch = await this.deps.regexWorkerPool.match({
              logs: pendingLogs,
              templates: [postTemplate],
              headPattern,
            });
            if (rematch.matched.length > 0) {
              allMatches.push(...rematch.matched);
              newlyMatchedCount += rematch.matched.length;
            }
            pendingLogs = rematch.unmatched;
          }

          await this.appendMatches(libraryId, library, allMatches, matchedRecords);

          if (newlyMatchedCount > 0) {
            if (this.deps.observer?.onMatching) {
              this.deps.observer.onMatching({
                lineIndex: sample.index,
                matched: newlyMatchedCount,
              });
            } else {
              this.logStage(sample.index, 'matching', `new template matched ${newlyMatchedCount} log(s)`);
            }
          }

          templateAccepted = true;
          continue;
        }

        const conflict = detectedConflicts[0];

        const refineResult = await this.deps.agents.refine.run(
          {
            candidateTemplate: validatedTemplate,
            candidateSamples: [sample.raw],
            conflictingTemplate: conflict.template,
            conflictingSamples: conflict.samples,
          },
          lineContext,
        );

        if (!refineResult.output) {
          this.logStage(sample.index, 'refine', 'failed');
          // Stop further refine attempts for this sample; record failure and move on.
          await this.recordFailure(
            sample.index,
            sample.raw,
            'refine',
            'Refine agent failed',
            validatedTemplate,
            { issues: refineResult.issues },
          );
          break;
        }

        if (refineResult.output.action === 'refine_candidate') {
          this.logStage(sample.index, 'refine', 'refining candidate');
          // Replace conflicting template with refined candidate to avoid repeated conflicts.
          await this.deps.templateManager.deleteTemplate(libraryId, conflict.template.id!);
          library.templates = library.templates.filter((t) => t.id !== conflict.template.id);
          currentTemplate = this.maybeAttachHeadMetadata(
            refineResult.output.template,
            sample,
            headPattern,
          );
          await this.recordRefineTrace(sample.index, sample.raw, refineResult.output, conflict.template);
          // After refinement, loop back to validation for the updated template.
          continue;
        }

        if (refineResult.output.action === 'adopt_candidate') {
          this.logStage(sample.index, 'refine', 'adopting candidate, removing conflicting template');
          await this.deps.templateManager.deleteTemplate(libraryId, conflict.template.id!);
          library.templates = library.templates.filter((t) => t.id !== conflict.template.id);
          currentTemplate = this.maybeAttachHeadMetadata(
            refineResult.output.template,
            sample,
            headPattern,
          );
          await this.recordRefineTrace(sample.index, sample.raw, refineResult.output, conflict.template);
          continue;
        }

        unresolvedSamples.push(sample.raw);
        break;
      }
    }

    const summary = {
      runId,
      source: routingResult.output.source,
      libraryId,
      totalLines: logs.length,
      matched: matchedRecords.length,
      unmatched: unresolvedSamples.length,
      newTemplates,
      conflicts,
      matchedRecords,
      unmatchedSamples: unresolvedSamples,
      failures: this.failures,
    };

    if (unresolvedSamples.length > 0) {
      this.deps.observer?.onUnmatched?.({ samples: unresolvedSamples });
    }

    return summary;
  }

  private toConflictFromIssues(sample: string, issues: string[]): TemplateConflict {
    return {
      candidate: {
        placeholderTemplate: sample,
        placeholderVariables: {},
      },
      conflictsWith: [],
      diagnostics: issues.map((issue) => ({ sample, reason: issue })),
    };
  }

  private async appendMatches(
    libraryId: string,
    library: TemplateLibrary,
    matches: MatchedLogRecord[],
    accumulator: MatchedLogRecord[],
  ): Promise<void> {
    if (matches.length === 0) {
      return;
    }
    accumulator.push(...matches);
    library.matchedSamples.push(...matches);
    await this.deps.templateManager.recordMatches(libraryId, matches);
  }

  private async validateTemplateMatch(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    lineIndex: number,
    headPattern?: HeadPatternDefinition,
  ): Promise<boolean> {
    const target = this.resolveTextForTemplate(template, sample, headPattern);
    if (!target.text) {
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(
        lineIndex,
        sample.raw,
        'validation',
        target.error ?? 'Template could not be applied to sample',
        template,
      );
      return false;
    }

    let runtime;
    try {
      runtime = buildRegexFromTemplate(
        template.placeholderTemplate,
        template.placeholderVariables,
        target.text,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const prefix = Number.isFinite(lineIndex)
        ? `[log-parser] line ${lineIndex + 1}`
        : '[log-parser] validation';
      console.error(`${prefix}: validation failed -> ${reason}`);
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(
        lineIndex,
        sample.raw,
        'validation',
        reason,
        template,
      );
      return false;
    }

    const matchResult = matchEntireLine(runtime.pattern, target.text);

    if (!matchResult.matched) {
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(
        lineIndex,
        sample.raw,
        'validation',
        'Template regex does not match sample',
        template,
        { matchError: matchResult.error },
      );
      return false;
    }

    return true;
  }

  private async persistTemplate(
    library: TemplateLibrary,
    libraryId: string,
    output: { action: string; template: LogTemplateDefinition },
  ): Promise<LogTemplateDefinition | undefined> {
    const template = output?.template;
    if (!template) {
      return undefined;
    }

    const templateWithId = await this.deps.templateManager.saveTemplate(libraryId, template);
    if (!library.templates.find((t) => t.id === templateWithId.id)) {
      library.templates.push(templateWithId);
    }
    return templateWithId;
  }

  private findConflicts(
    candidate: LogTemplateDefinition,
    library: TemplateLibrary,
    headPattern?: HeadPatternDefinition,
  ): Array<{ template: LogTemplateDefinition; samples: string[] }> {
    const candidateRuntime = buildRegexFromTemplate(
      candidate.placeholderTemplate,
      candidate.placeholderVariables,
      undefined,
    );
    const conflicts = new Map<string, { template: LogTemplateDefinition; samples: string[] }>();
    const templateMap = new Map(library.templates.map((t) => [t.id ?? '', t]));

    for (const sample of library.matchedSamples) {
      if (!sample.raw) continue;

      const pseudoEntry: RegexLogEntry = {
        raw: sample.raw,
        index: sample.lineIndex ?? 0,
        content: sample.content,
      };
      const target = this.resolveTextForTemplate(candidate, pseudoEntry, headPattern);
      if (!target.text) continue;

      const result = matchEntireLine(candidateRuntime.pattern, target.text);
      if (!result.matched) continue;

      const key = sample.template?.id ?? 'unknown';
      const template = templateMap.get(sample.template?.id ?? '');
      if (!template) continue;

      if (!conflicts.has(key)) {
        conflicts.set(key, { template, samples: [] });
      }
      conflicts.get(key)!.samples.push(sample.raw);
    }

    return Array.from(conflicts.values());
  }

  private async ensureHeadPattern(params: {
    logs: string[];
    libraryId: string;
    library: TemplateLibrary;
    context: AgentContext;
  }): Promise<HeadPatternDefinition | undefined> {
    const headAgent = this.deps.agents.head;
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
      const result = await headAgent.run({ samples }, params.context);
        if (result.status === 'success' && result.output?.pattern) {
          current = result.output;
          params.library.headPattern = current;
          if (this.deps.templateManager.saveHeadPattern) {
            await this.deps.templateManager.saveHeadPattern(params.libraryId, current);
          }
          console.log(`[log-parser] head regex (initial): ${current.pattern}`);
          this.deps.observer?.onStage?.({
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
      const coverage = this.evaluateHeadCoverage(params.logs, pattern);
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
      if (newPicks.length > 0) {
        console.log(
          `[log-parser] head new samples (round ${round + 1}):\n${newPicks
            .map((s) => `  ${s}`)
            .join('\n')}`,
        );
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
        { samples: refineSamples, previousPattern: current.pattern },
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
      if (next.unmatched.length < bestState.unmatched.length) {
        bestState = next;
        bestPattern = next.pattern;
        current = next.pattern;
        params.library.headPattern = current;
        if (this.deps.templateManager.saveHeadPattern) {
          await this.deps.templateManager.saveHeadPattern(params.libraryId, current);
        }
        this.deps.observer?.onStage?.({
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
    if (bestPattern && this.deps.templateManager.saveHeadPattern) {
      await this.deps.templateManager.saveHeadPattern(params.libraryId, bestPattern);
    }

    if (bestState.unmatched.length > 0) {
      this.deps.observer?.onStage?.({
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

  private createEntriesWithHead(
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
          entry.headMatched = false;
        }
      }
      return entry;
    });
  }

  private evaluateHeadCoverage(
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

  private selectParsingInput(sample: RegexLogEntry, headPattern?: HeadPatternDefinition): string {
    if (headPattern && sample.content !== undefined) {
      return sample.content;
    }
    return sample.content ?? sample.raw;
  }

  private maybeAttachHeadMetadata(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): LogTemplateDefinition {
    if (!headPattern) {
      return template;
    }
    const metadata = {
      ...(template.metadata ?? {}),
      contentOnly: true,
      headPattern: headPattern.pattern,
      rawSample: sample.raw,
      contentSample: sample.content ?? sample.raw,
    };
    return {
      ...template,
      metadata,
    };
  }

  private resolveTextForTemplate(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): { text?: string; error?: string } {
    const contentOnly = Boolean(template.metadata?.['contentOnly']);
    if (!contentOnly) {
      return { text: sample.raw };
    }
    if (sample.content) {
      return { text: sample.content };
    }
    if (!headPattern?.pattern) {
      return { text: sample.raw };
    }
    const extraction = extractContentWithHead(sample.raw, headPattern);
    if (!extraction.matched) {
      // Tolerate head mismatch by treating the whole line as content.
      return { text: sample.raw };
    }
    return { text: extraction.content ?? sample.raw };
  }

  private sanitizeVariableName(name: string): string {
    const cleaned = name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
    if (!cleaned) {
      return 'var';
    }
    return cleaned;
  }
}
