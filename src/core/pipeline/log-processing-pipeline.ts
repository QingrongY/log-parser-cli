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
} from '../../agents/index.js';
import type { AgentResult, LogTemplateDefinition } from '../../agents/index.js';
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
import { normalizeRegexPattern } from '../../agents/utils/regex.js';

interface PipelineAgents {
  routing: RoutingAgent;
  parsing: ParsingAgent;
  refine: RefineAgent;
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
    this.deps.observer?.onRouting?.({
      source: routingResult.output.source,
      libraryId,
      existingTemplates: library.templates.length,
    });
    const initialEntries: RegexLogEntry[] = logs.map((raw, index) => ({
      raw,
      index,
    }));
    const matchResult = await this.deps.regexWorkerPool.match({
      logs: initialEntries,
      templates: library.templates,
    });

    await this.deps.templateManager.recordMatches(libraryId, matchResult.matched);
    library.matchedSamples.push(...matchResult.matched);
    this.deps.observer?.onExistingMatchSummary?.({
      matched: matchResult.matched.length,
      unmatched: matchResult.unmatched.length,
    });

    const pipelineContext: AgentContext = {
      runId,
      sourceHint: routingResult.output.source,
      templateLibraryId: libraryId,
      userPreferences: { variableHints: options.variableHints },
    };

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
          samples: [sample.raw],
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

      let currentTemplate: LogTemplateDefinition = parseResult.output;
      let templateAccepted = false;
      let refineAttempts = 0;
      const maxRefineAttempts = 10;

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
          sample.raw,
          sample.index,
        );

        if (!isValid) {
          unresolvedSamples.push(sample.raw);
          break;
        }

        const validatedTemplate = currentTemplate;
        const detectedConflicts = this.findConflicts(validatedTemplate, library);

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
          });

          const allMatches: MatchedLogRecord[] = [...sampleMatch.matched];
          let newlyMatchedCount = sampleMatch.matched.length;

          if (pendingLogs.length > 0) {
            const rematch = await this.deps.regexWorkerPool.match({
              logs: pendingLogs,
              templates: [postTemplate],
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
        refineAttempts++;

        // Prevent infinite refine loop
        if (refineAttempts > maxRefineAttempts) {
          this.logStage(sample.index, 'refine', `exceeded max attempts (${maxRefineAttempts}), skipping`);
          await this.recordFailure(
            sample.index,
            sample.raw,
            'refine',
            `Exceeded maximum refine attempts (${maxRefineAttempts})`,
            validatedTemplate,
            { conflictingTemplateId: conflict.template.id },
          );
          unresolvedSamples.push(sample.raw);
          break;
        }

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
          await this.recordFailure(
            sample.index,
            sample.raw,
            'refine',
            'Refine agent failed',
            validatedTemplate,
            { issues: refineResult.issues },
          );
          conflicts.push({
            candidate: validatedTemplate,
            conflictsWith: [conflict.template],
            diagnostics: [
              {
                sample: sample.raw,
                reason: refineResult.issues?.join('; ') ?? 'Refine agent failed.',
              },
            ],
          });
          unresolvedSamples.push(sample.raw);
          break;
        }

        if (refineResult.output.action === 'refine_candidate') {
          this.logStage(sample.index, 'refine', `refining candidate (${refineAttempts}/${maxRefineAttempts})`);
          currentTemplate = refineResult.output.template;
          continue;
        }

        if (refineResult.output.action === 'adopt_candidate') {
          this.logStage(sample.index, 'refine', 'adopting candidate, removing conflicting template');
          await this.deps.templateManager.deleteTemplate(libraryId, conflict.template.id!);
          library.templates = library.templates.filter((t) => t.id !== conflict.template.id);
          currentTemplate = refineResult.output.template;
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
    sample: string,
    lineIndex: number,
  ): Promise<boolean> {
    const runtime = buildRegexFromTemplate(
      template.placeholderTemplate,
      template.placeholderVariables,
      sample,
    );
    const matchResult = matchEntireLine(runtime.pattern, sample);

    if (!matchResult.matched) {
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(
        lineIndex,
        sample,
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

      const result = matchEntireLine(candidateRuntime.pattern, sample.raw);
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

  private sanitizeVariableName(name: string): string {
    const cleaned = name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
    if (!cleaned) {
      return 'var';
    }
    return cleaned;
  }
}
