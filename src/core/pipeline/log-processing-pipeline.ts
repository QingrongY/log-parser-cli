/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentContext,
  ParsingAgent,
  RepairAgent,
  RoutingAgent,
  UpdateAgent,
  ValidationAgent,
  UpdateAgentOutput,
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
  validation: ValidationAgent;
  repair: RepairAgent;
  update: UpdateAgent;
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
      await appendFile(this.deps.failureLogPath, JSON.stringify(failure, null, 2) + '\n', 'utf-8').catch(() => {});
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
        conflicts.push(
          this.toConflictFromIssues(sample.raw, parseResult.issues ?? ['Parsing agent failed.']),
        );
        unresolvedSamples.push(sample.raw);
        continue;
      }

      let currentTemplate: LogTemplateDefinition = parseResult.output;
      let templateAccepted = false;
      let retryCount = 0;

      while (!templateAccepted) {
        if (
          skipThreshold > 0 &&
          pendingLogs.length + (sample ? 1 : 0) <= skipThreshold
        ) {
          unresolvedSamples.push(sample.raw);
          this.logStage(sample.index, 'update', `skipped due to threshold ${skipThreshold}`);
          break;
        }
        const validatedTemplate = await this.validateAndRepair(
          currentTemplate,
          [sample.raw],
          lineContext,
        );

        if (!validatedTemplate) {
          conflicts.push({
            candidate: currentTemplate,
            conflictsWith: [],
            diagnostics: [
              {
                sample: sample.raw,
                reason: 'Validation/repair agents exhausted without success.',
              },
            ],
          });
          unresolvedSamples.push(sample.raw);
          break;
        }
        const updateResult = await this.deps.agents.update.run(
          {
            template: validatedTemplate,
            existingTemplates: library.templates,
            librarySamples: library.matchedSamples.map((record) => ({
              raw: record.raw,
              templateId: record.template?.id,
            })),
            candidateSamples: [sample.raw],
          },
          lineContext,
        );

        if (!updateResult.output) {
          this.logStage(sample.index, 'update', 'failed');
          await this.recordFailure(
            sample.index,
            sample.raw,
            'update',
            'Update agent failed',
            validatedTemplate,
            { issues: updateResult.issues },
          );
          conflicts.push({
            candidate: validatedTemplate,
            conflictsWith: [],
            diagnostics: [
              {
                sample: sample.raw,
                reason: updateResult.issues?.join('; ') ?? 'Update agent failed.',
              },
            ],
          });
          unresolvedSamples.push(sample.raw);
          break;
        }

        if (updateResult.output.action === 'conflict') {
          this.logStage(sample.index, 'update', 'conflict', { action: 'conflict' });
          await this.recordFailure(
            sample.index,
            sample.raw,
            'update',
            'Template conflict detected',
            validatedTemplate,
            { conflicts: updateResult.output.conflictingTemplates },
          );
          conflicts.push({
            candidate: validatedTemplate,
            conflictsWith: updateResult.output.conflictingTemplates ?? [],
          });
          unresolvedSamples.push(sample.raw);
          break;
        }

        if (updateResult.output.action === 'retry') {
          this.logStage(sample.index, 'update', 'retry requested', { action: 'retry' });
          retryCount += 1;
          if (retryCount > 1) {
            await this.recordFailure(
              sample.index,
              sample.raw,
              'update',
              'Template exceeded retry limit; human review required.',
              updateResult.output.template,
            );
            conflicts.push({
              candidate: updateResult.output.template,
              conflictsWith: [],
              diagnostics: [
                {
                  sample: sample.raw,
                  reason: 'Template exceeded retry limit; human review required.',
                },
              ],
            });
            unresolvedSamples.push(sample.raw);
            break;
          }
          currentTemplate = updateResult.output.template;
          continue;
        }

        let postUpdateTemplate = updateResult.output.template;
        if (!postUpdateTemplate) {
          unresolvedSamples.push(sample.raw);
          break;
        }

        this.logStage(sample.index, 'update', `action=${updateResult.output.action}`, {
          action: updateResult.output.action,
        });

        const revalidatedTemplate = await this.validateAndRepair(
          postUpdateTemplate,
          [sample.raw],
          lineContext,
        );

        if (!revalidatedTemplate) {
          await this.recordFailure(sample.index, sample.raw, 'validation', 'Template failed revalidation after update', postUpdateTemplate);
          conflicts.push({
            candidate: postUpdateTemplate,
            conflictsWith: [],
            diagnostics: [
              {
                sample: sample.raw,
                reason: 'Template failed validation after update/repair.',
              },
            ],
          });
          unresolvedSamples.push(sample.raw);
          break;
        }

        postUpdateTemplate = revalidatedTemplate;

        const sampleMatch = await this.deps.regexWorkerPool.match({
          logs: [sample],
          templates: [postUpdateTemplate],
        });

        if (sampleMatch.matched.length === 0) {
          await this.recordFailure(sample.index, sample.raw, 'matching', 'Template does not match log after update', postUpdateTemplate);
          unresolvedSamples.push(sample.raw);
          break;
        }

        if (updateResult.output.action !== 'skipped') {
          await this.persistTemplate(library, libraryId, {
            ...updateResult.output,
            template: postUpdateTemplate,
          });
          newTemplates.push(postUpdateTemplate);
        }
        let newlyMatchedCount = 0;
        await this.appendMatches(libraryId, library, sampleMatch.matched, matchedRecords);
        newlyMatchedCount += sampleMatch.matched.length;

        let rematch = { matched: [] as MatchedLogRecord[], unmatched: pendingLogs };
        if (pendingLogs.length > 0) {
          rematch = await this.deps.regexWorkerPool.match({
            logs: pendingLogs,
            templates: [postUpdateTemplate],
          });
          if (rematch.matched.length > 0) {
            await this.appendMatches(libraryId, library, rematch.matched, matchedRecords);
            newlyMatchedCount += rematch.matched.length;
          }
          pendingLogs = rematch.unmatched;
        }

        // Tighten constants if some variables are identical across all matched samples for this template.
        const tightened = await this.tightenTemplateConstants(
          postUpdateTemplate,
          [...sampleMatch.matched, ...rematch.matched],
          libraryId,
          library,
          newTemplates,
        );
        if (tightened) {
          postUpdateTemplate = tightened;
        }

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

  private async validateAndRepair(
    candidate: LogTemplateDefinition,
    samples: string[],
    context: AgentContext,
  ): Promise<LogTemplateDefinition | undefined> {
    const lineIndex = this.extractLineIndex(context);
    if (lineIndex === undefined) {
      throw new Error('validateAndRepair requires lineIndex in context');
    }

    const sample = samples[0] ?? '';
    const runtime = buildRegexFromTemplate(
      candidate.placeholderTemplate,
      candidate.placeholderVariables,
      sample,
    );
    const matchResult = matchEntireLine(runtime.pattern, sample);
    if (!matchResult.matched) {
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(lineIndex, sample, 'validation', 'Template did not match sample; cannot validate variables.', candidate, {
        matchError: matchResult.error,
      });
      return undefined;
    }

    const validationResult = await this.deps.agents.validation.run(
      {
        sample,
        variables: matchResult.variables,
      },
      context,
    );

    if (validationResult.output?.isValid) {
      return candidate;
    }

    if (!validationResult.output) {
      this.logStage(lineIndex, 'validation', 'failed');
      await this.recordFailure(
        lineIndex,
        sample,
        'validation',
        'Validation agent did not return output.',
        candidate,
        { issues: validationResult.issues },
      );
      return undefined;
    }

    this.logStage(lineIndex, 'validation', 'failed');

    const repairResult = await this.deps.agents.repair.run(
      {
        template: candidate,
        diagnostics: validationResult.output.diagnostics,
        samples,
      },
      context,
    );

    if (repairResult.status !== 'success' || !repairResult.output) {
      this.logStage(lineIndex, 'repair', 'failed');
      await this.recordFailure(
        lineIndex,
        sample,
        'repair',
        'Repair agent failed to fix validation issues.',
        candidate,
        { diagnostics: validationResult.output.diagnostics },
      );
      return undefined;
    }

    return repairResult.output.template;
  }

  private async persistTemplate(
    library: TemplateLibrary,
    libraryId: string,
    updateOutput: AgentResult<UpdateAgentOutput>['output'],
  ): Promise<LogTemplateDefinition | undefined> {
    const template = updateOutput?.template;
    if (!template) {
      return undefined;
    }

    const templateWithId = await this.deps.templateManager.saveTemplate(libraryId, template);
    const replacedIds = new Set(updateOutput?.replacedTemplateIds ?? []);
    if (templateWithId.id) {
      replacedIds.add(templateWithId.id);
    }
    const remaining = library.templates.filter(
      (entry) => !replacedIds.has(entry.id ?? ''),
    );
    remaining.push(templateWithId);
    library.templates = remaining;
    return templateWithId;
  }

  /**
   * If a variable captures the exact same value for all matched samples of a new template,
   * fold it back into the template as a literal constant to avoid over-broad placeholders.
   * This runs right after the first batch of matches for the new template.
   */
  private async tightenTemplateConstants(
    template: LogTemplateDefinition,
    matches: MatchedLogRecord[],
    libraryId: string,
    library: TemplateLibrary,
    newTemplates: LogTemplateDefinition[],
  ): Promise<LogTemplateDefinition | undefined> {
    if (!template.placeholderTemplate || matches.length === 0) {
      return undefined;
    }

    // Extract placeholders in order of appearance.
    const placeholderRegex = /\u001b]9;var=([^\u0007]+)\u0007/g;
    const placeholders: { name: string; start: number; end: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = placeholderRegex.exec(template.placeholderTemplate)) !== null) {
      placeholders.push({
        name: match[1],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    if (placeholders.length === 0) {
      return undefined;
    }

    // Derive final variable names (sanitized + numbered) to align with regex groups.
    const nameCounts = new Map<string, number>();
    const finalNames = placeholders.map((p) => {
      const base = this.sanitizeVariableName(p.name);
      const count = (nameCounts.get(base) ?? 0) + 1;
      nameCounts.set(base, count);
      return count === 1 ? base : `${base}${count}`;
    });

    // Collect values per variable.
    const constants = new Map<number, string>();
    finalNames.forEach((varName, idx) => {
      const values = matches
        .map((m) => m.variables?.[varName])
        .filter((v): v is string => typeof v === 'string');
      if (values.length === 0) {
        return;
      }
      const first = values[0];
      if (values.every((v) => v === first)) {
        constants.set(idx, first);
      }
    });

    if (constants.size === 0) {
      return undefined;
    }

    // Rebuild the placeholder template, replacing constant placeholders with their literal value.
    let cursor = 0;
    let tightenedTemplate = '';
    placeholders.forEach((ph, idx) => {
      tightenedTemplate += template.placeholderTemplate.slice(cursor, ph.start);
      if (constants.has(idx)) {
        tightenedTemplate += constants.get(idx);
      } else {
        tightenedTemplate += template.placeholderTemplate.slice(ph.start, ph.end);
      }
      cursor = ph.end;
    });
    tightenedTemplate += template.placeholderTemplate.slice(cursor);

    if (tightenedTemplate === template.placeholderTemplate) {
      return undefined;
    }

    const remainingPlaceholders =
      (tightenedTemplate.match(/\u001b]9;var=[^\u0007]+\u0007/g) ?? []).length;
    if (remainingPlaceholders === 0) {
      return undefined;
    }

    const sampleRaw = matches[0]?.raw;
    const { pattern, variables } = buildRegexFromTemplate(
      tightenedTemplate,
      template.placeholderVariables ?? {},
      sampleRaw,
    );
    const normalizedPattern = normalizeRegexPattern(pattern);

    template.placeholderTemplate = tightenedTemplate;
    template.pattern = normalizedPattern;
    template.variables = variables;

    // Persist tightened template and refresh library/newTemplates references.
    const saved = await this.deps.templateManager.saveTemplate(libraryId, template);
    if (saved.id) {
      library.templates = library.templates.map((t) => (t.id === saved.id ? saved : t));
      for (let i = 0; i < newTemplates.length; i += 1) {
        if (newTemplates[i].id === saved.id) {
          newTemplates[i] = saved;
        }
      }
    }

    return template;
  }

  private sanitizeVariableName(name: string): string {
    const cleaned = name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
    if (!cleaned) {
      return 'var';
    }
    return cleaned;
  }
}
