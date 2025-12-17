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
    const { promptUsed, ...restDetails } = details ?? {};
    const enrichedDetails = { ...restDetails };
    // Keep LLM output and reconstruction traces if provided by agents.
    if (details?.['llmOutput']) {
      enrichedDetails.llmOutput = details['llmOutput'];
    }
    if (details?.['failedTemplate']) {
      enrichedDetails.failedTemplate = details['failedTemplate'];
    }
    if (details?.['failedReconstruction']) {
      enrichedDetails.failedReconstruction = details['failedReconstruction'];
    }

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
    console.error(`[log-parser] failure: ${JSON.stringify(failure)}`);
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
    console.log(`[log-parser] refine-trace: ${JSON.stringify(trace)}`);
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
      const remainingLogs = pendingLogs.length + 1;
      if (skipThreshold > 0 && remainingLogs <= skipThreshold) {
        this.logStage(
          sample.index,
          'update',
          `skipped remaining ${remainingLogs} log(s) (threshold ${skipThreshold})`,
        );
        unresolvedSamples.push(sample.raw, ...pendingLogs.map((entry) => entry.raw));
        pendingLogs = [];
        break;
      }
      const lineContext: AgentContext = {
        ...pipelineContext,
        metadata: {
          ...(pipelineContext.metadata ?? {}),
          lineIndex: sample.index,
        },
      };
      pendingLogs = await this.processSample({
        sample,
        pendingLogs,
        library,
        libraryId,
        headPattern,
        variableHints: options.variableHints,
        context: lineContext,
        matchedRecords,
        newTemplates,
        conflicts,
        unresolvedSamples,
      });
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
      unmatchedSamples: unresolvedSamples.map((s) => s),
      failures: this.failures,
    };

    if (unresolvedSamples.length > 0) {
      this.deps.observer?.onUnmatched?.({ samples: unresolvedSamples });
    }

    return summary;
  }

  private async processSample(params: {
    sample: RegexLogEntry;
    pendingLogs: RegexLogEntry[];
    library: TemplateLibrary;
    libraryId: string;
    headPattern?: HeadPatternDefinition;
    variableHints?: string[];
    context: AgentContext;
    matchedRecords: MatchedLogRecord[];
    newTemplates: LogTemplateDefinition[];
    conflicts: TemplateConflict[];
    unresolvedSamples: string[];
  }): Promise<RegexLogEntry[]> {
    const {
      sample,
      pendingLogs,
      library,
      libraryId,
      headPattern,
      variableHints,
      context,
      matchedRecords,
      newTemplates,
      conflicts,
      unresolvedSamples,
    } = params;
    const content = this.getContent(sample, headPattern);
    if (headPattern?.pattern && content === undefined) {
      this.logStage(sample.index, 'parsing', 'failed (head content missing)');
      await this.recordFailure(sample.index, sample.raw, 'parsing', 'Head content missing', undefined, {
        headPattern: headPattern.pattern,
      });
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    const parseResult = await this.deps.agents.parsing.run(
      {
        samples: [content ?? ''],
        variableHints,
      },
      context,
    );

    if (parseResult.status !== 'success' || !parseResult.output) {
      this.logStage(sample.index, 'parsing', 'failed');
      const issueText = parseResult.issues?.join('; ') ?? 'unknown';
      const reconstructed = (parseResult.diagnostics as Record<string, unknown> | undefined)?.[
        'failedReconstruction'
      ] as string | undefined;
      const contentShown = content ?? '';
      if (reconstructed) {
        console.warn(
          `[log-parser] line ${sample.index}: parsing-agent failed -> ${issueText}; reconstructed="${reconstructed}"; content="${contentShown}"`,
        );
      } else {
        console.warn(`[log-parser] line ${sample.index}: parsing-agent failed -> ${issueText}`);
      }
      await this.recordFailure(
        sample.index,
        sample.raw,
        'parsing',
        'Parsing agent failed',
        undefined,
        {
          issues: parseResult.issues,
          diagnostics: parseResult.diagnostics,
          contentUsed: contentShown,
          headPattern: headPattern?.pattern,
        },
      );
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    const parsedTemplate: LogTemplateDefinition = this.maybeAttachHeadMetadata(
      parseResult.output,
      sample,
      headPattern,
    );

    if (!(await this.validateTemplateMatch(parsedTemplate, sample, sample.index, headPattern))) {
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    const detectedConflicts = this.findConflicts(parsedTemplate, library, headPattern);
    if (detectedConflicts.length === 0) {
      this.logStage(sample.index, 'update', 'added new template', { action: 'added' });
      return this.finalizeTemplate({
        template: parsedTemplate,
        sample,
        pendingLogs,
        library,
        libraryId,
        headPattern,
        matchedRecords,
        newTemplates,
      });
    }

    conflicts.push({
      candidate: parsedTemplate,
      conflictsWith: detectedConflicts.map((c) => c.template),
    });

    const conflict = detectedConflicts[0];
    const refineResult = await this.deps.agents.refine.run(
      {
        candidateTemplate: parsedTemplate,
        candidateSamples: [content ?? ''],
        conflictingTemplate: conflict.template,
        conflictingSamples: conflict.samples
          .map((raw) => this.getContentFromRaw(raw, headPattern))
          .filter((s): s is string => Boolean(s)),
      },
      context,
    );

    if (!refineResult.output) {
      this.logStage(sample.index, 'refine', 'failed');
      await this.recordFailure(sample.index, sample.raw, 'refine', 'Refine agent failed', parsedTemplate, {
        issues: refineResult.issues,
      });
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    await this.recordRefineTrace(sample.index, sample.raw, refineResult.output, conflict.template);
    if (conflict.template.id) {
      await this.deps.templateManager.deleteTemplate(libraryId, conflict.template.id);
    }
    library.templates = library.templates.filter((t) => t.id !== conflict.template.id);

    const refinedTemplate = this.maybeAttachHeadMetadata(
      refineResult.output.template,
      sample,
      headPattern,
    );

    if (!(await this.validateTemplateMatch(refinedTemplate, sample, sample.index, headPattern))) {
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    const remainingConflicts = this.findConflicts(refinedTemplate, library, headPattern);
    if (remainingConflicts.length > 0) {
      conflicts.push({
        candidate: refinedTemplate,
        conflictsWith: remainingConflicts.map((c) => c.template),
      });
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    this.logStage(sample.index, 'refine', 'accepted refined template');
    return this.finalizeTemplate({
      template: refinedTemplate,
      sample,
      pendingLogs,
      library,
      libraryId,
      headPattern,
      matchedRecords,
      newTemplates,
    });
  }

  private async finalizeTemplate(params: {
    template: LogTemplateDefinition;
    sample: RegexLogEntry;
    pendingLogs: RegexLogEntry[];
    library: TemplateLibrary;
    libraryId: string;
    headPattern?: HeadPatternDefinition;
    matchedRecords: MatchedLogRecord[];
    newTemplates: LogTemplateDefinition[];
  }): Promise<RegexLogEntry[]> {
    const {
      template,
      sample,
      pendingLogs,
      library,
      libraryId,
      headPattern,
      matchedRecords,
      newTemplates,
    } = params;

    const savedTemplate = await this.persistTemplate(library, libraryId, {
      action: 'added',
      template,
    });
    const activeTemplate = savedTemplate ?? template;
    newTemplates.push(activeTemplate);

    const sampleMatch = await this.deps.regexWorkerPool.match({
      logs: [sample],
      templates: [activeTemplate],
      headPattern,
    });

    const allMatches: MatchedLogRecord[] = [...sampleMatch.matched];
    let updatedPending = pendingLogs;

    if (pendingLogs.length > 0) {
      const rematch = await this.deps.regexWorkerPool.match({
        logs: pendingLogs,
        templates: [activeTemplate],
        headPattern,
      });
      updatedPending = rematch.unmatched;
      if (rematch.matched.length > 0) {
        allMatches.push(...rematch.matched);
      }
    }

    if (allMatches.length > 0) {
      await this.appendMatches(libraryId, library, allMatches, matchedRecords);
      if (this.deps.observer?.onMatching) {
        this.deps.observer.onMatching({
          lineIndex: sample.index,
          matched: allMatches.length,
        });
      } else {
        this.logStage(sample.index, 'matching', `new template matched ${allMatches.length} log(s)`);
      }
    }

    return updatedPending;
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
    const target = this.getTextForTemplate(template, sample, headPattern);
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
      const target = this.getTextForTemplate(candidate, pseudoEntry, headPattern);
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
        const result = await headAgent.run({ samples, newSamples: samples }, params.context);
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
          // If head doesn't match, treat as failure to extract content.
          entry.headMatched = false;
          entry.content = undefined;
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

  private getTextForTemplate(
    template: LogTemplateDefinition,
    sample: RegexLogEntry,
    headPattern?: HeadPatternDefinition,
  ): { text?: string; error?: string } {
    const contentOnly = Boolean(template.metadata?.['contentOnly']);
    if (!contentOnly) {
      return { text: sample.raw };
    }
    if (headPattern?.pattern && sample.content !== undefined) {
      return { text: sample.content };
    }
    // No content extracted; treat as failure.
    return { text: undefined, error: 'Head extraction missing content' };
  }

  private getContent(entry: RegexLogEntry, headPattern?: HeadPatternDefinition): string | undefined {
    if (headPattern?.pattern) {
      return entry.content;
    }
    return entry.raw;
  }

  private getContentFromRaw(raw: string, headPattern?: HeadPatternDefinition): string | undefined {
    if (!headPattern?.pattern) {
      return raw;
    }
    const extraction = extractContentWithHead(raw, headPattern);
    if (!extraction.matched) {
      return undefined;
    }
    return extraction.content;
  }
}
