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
  LogTemplateDefinition,
} from '../../agents/index.js';
import type { ProcessingObserver, StageEvent } from '../../types/observer.js';
import { RegexWorkerPool } from '../regex-worker-pool.js';
import type { RegexLogEntry } from '../regex-worker-pool.js';
import type {
  LogProcessingOptions,
  LogProcessingSummary,
  MatchedLogRecord,
  TemplateConflict,
  TemplateLibrary,
  TemplateManager,
  FailureRecord,
} from '../types.js';
import { HeadPatternManager } from '../head-pattern/manager.js';
import { TemplateValidator } from '../validation/template-validator.js';
import { ConflictDetector } from '../validation/conflict-detector.js';
import { logConsole, colorizePlaceholders, diffStrings } from '../logging.js';

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

/**
 * Main pipeline for processing log files with LLM-powered template extraction.
 * Coordinates routing, parsing, refinement, and matching phases.
 */
export class LogProcessingPipeline {
  private readonly headPatternManager: HeadPatternManager;
  private readonly templateValidator: TemplateValidator;
  private readonly conflictDetector: ConflictDetector;
  private failures: FailureRecord[] = [];

  constructor(private readonly deps: LogProcessingPipelineDeps) {
    this.headPatternManager = new HeadPatternManager({
      headAgent: deps.agents.head,
      templateManager: deps.templateManager,
      observer: deps.observer,
    });
    this.templateValidator = new TemplateValidator();
    this.conflictDetector = new ConflictDetector();
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
    };

    this.deps.observer?.onRouting?.({
      source: routingResult.output.source,
      libraryId,
      existingTemplates: library.templates.length,
    });

    const headPattern = await this.headPatternManager.ensureHeadPattern({
      logs,
      libraryId,
      library,
      context: pipelineContext,
    });

    const initialEntries: RegexLogEntry[] = this.headPatternManager.createEntriesWithHead(logs, headPattern);
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
      context,
      matchedRecords,
      newTemplates,
      conflicts,
      unresolvedSamples,
    } = params;
    const content = this.headPatternManager.getContent(sample, headPattern);
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

    const parsedTemplate: LogTemplateDefinition = this.templateValidator.attachHeadMetadata(
      parseResult.output,
      sample,
      headPattern,
    );

    const validationResult = await this.templateValidator.validate(parsedTemplate, sample, headPattern);
    if (!validationResult.valid) {
      this.logStage(sample.index, 'validation', 'failed');
      await this.recordFailure(
        sample.index,
        sample.raw,
        'validation',
        validationResult.error ?? 'Template validation failed',
        parsedTemplate,
        validationResult.details,
      );
      unresolvedSamples.push(sample.raw);
      return pendingLogs;
    }

    const detectedConflicts = this.conflictDetector.findConflicts(parsedTemplate, library, headPattern);
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
    const conflictIdsPreview = detectedConflicts
      .slice(0, 5)
      .map((c) => c.template.id ?? 'unknown')
      .join(', ');
    this.logStage(
      sample.index,
      'refine',
      `conflicts detected with ${detectedConflicts.length} template(s): ${conflictIdsPreview}`,
    );
    const refineResult = await this.deps.agents.refine.run(
      {
        candidateTemplate: parsedTemplate,
        candidateSamples: [content ?? ''],
        conflictingTemplate: conflict.template,
        conflictingSamples: conflict.samples
          .map((raw) => this.headPatternManager.getContentFromRaw(raw, headPattern))
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

    const accumulatedOrphanedLogs: RegexLogEntry[] = await this.removeConflictingTemplates({
      conflicts: detectedConflicts,
      library,
      libraryId,
      matchedRecords,
    });

    let currentTemplate = this.templateValidator.attachHeadMetadata(
      refineResult.output.template,
      sample,
      headPattern,
    );

    const refinedValidation = await this.templateValidator.validate(currentTemplate, sample, headPattern);
    if (!refinedValidation.valid) {
      this.logStage(sample.index, 'validation', 'failed (refined)');
      await this.recordFailure(
        sample.index,
        sample.raw,
        'validation',
        refinedValidation.error ?? 'Refined template validation failed',
        currentTemplate,
        refinedValidation.details,
      );
      unresolvedSamples.push(sample.raw);
      return [...pendingLogs, ...accumulatedOrphanedLogs];
    }

    let iteration = 0;
    const MAX_REFINE_ITERATIONS = 5;

    while (iteration < MAX_REFINE_ITERATIONS) {
      const remainingConflicts = this.conflictDetector.findConflicts(currentTemplate, library, headPattern);

      if (remainingConflicts.length === 0) {
        this.logStage(sample.index, 'refine', 'accepted refined template');
        return this.finalizeTemplate({
          template: currentTemplate,
          sample,
          pendingLogs: [...pendingLogs, ...accumulatedOrphanedLogs],
          library,
          libraryId,
          headPattern,
          matchedRecords,
          newTemplates,
        });
      }

      const nextConflict = remainingConflicts[0];
      const preview = remainingConflicts
        .slice(0, 5)
        .map((c) => c.template.id ?? 'unknown')
        .join(', ');
      this.logStage(
        sample.index,
        'refine',
        `iteration ${iteration + 1}: resolving conflicts (${remainingConflicts.length}) e.g. ${preview}`,
      );

      const nextRefineResult = await this.deps.agents.refine.run(
        {
          candidateTemplate: currentTemplate,
          candidateSamples: [content ?? ''],
          conflictingTemplate: nextConflict.template,
          conflictingSamples: nextConflict.samples
            .map((raw) => this.headPatternManager.getContentFromRaw(raw, headPattern))
            .filter((s): s is string => Boolean(s)),
        },
        context,
      );

      if (!nextRefineResult.output) {
        this.logStage(sample.index, 'refine', `failed at iteration ${iteration + 1}`);
        await this.recordFailure(
          sample.index,
          sample.raw,
          'refine',
          `Refine agent failed at iteration ${iteration + 1}`,
          currentTemplate,
          { issues: nextRefineResult.issues },
        );
        unresolvedSamples.push(sample.raw);
        return [...pendingLogs, ...accumulatedOrphanedLogs];
      }

      await this.recordRefineTrace(sample.index, sample.raw, nextRefineResult.output, nextConflict.template);

      const requeued = await this.removeConflictingTemplates({
        conflicts: remainingConflicts,
        library,
        libraryId,
        matchedRecords,
      });
      if (requeued.length > 0) {
        accumulatedOrphanedLogs.push(...requeued);
        this.logStage(
          sample.index,
          'refine',
          `re-queued ${requeued.length} log(s) from deleted templates (iteration ${iteration + 1})`,
        );
      }

      currentTemplate = this.templateValidator.attachHeadMetadata(
        nextRefineResult.output.template,
        sample,
        headPattern,
      );

      const validation = await this.templateValidator.validate(currentTemplate, sample, headPattern);
      if (!validation.valid) {
        this.logStage(sample.index, 'validation', `failed (refined, iteration ${iteration + 1})`);
        await this.recordFailure(
          sample.index,
          sample.raw,
          'validation',
          validation.error ?? 'Refined template validation failed',
          currentTemplate,
          validation.details,
        );
        unresolvedSamples.push(sample.raw);
        return [...pendingLogs, ...accumulatedOrphanedLogs];
      }

      iteration++;
    }

    this.logStage(sample.index, 'refine', `max iterations (${MAX_REFINE_ITERATIONS}) reached`);
    const finalConflicts = this.conflictDetector.findConflicts(currentTemplate, library, headPattern);
    conflicts.push({
      candidate: currentTemplate,
      conflictsWith: finalConflicts.map((c) => c.template),
    });
    unresolvedSamples.push(sample.raw);
    return [...pendingLogs, ...accumulatedOrphanedLogs];
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
    // Deduplicate by line index + raw content to avoid double-counting when logs are re-queued.
    const seen = new Set(
      accumulator.map((m) => `${m.lineIndex ?? -1}:${m.raw}`),
    );
    const unique = matches.filter((m) => {
      const key = `${m.lineIndex ?? -1}:${m.raw}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    if (unique.length === 0) {
      return;
    }

    accumulator.push(...unique);
    library.matchedSamples.push(...unique);
    await this.deps.templateManager.recordMatches(libraryId, unique);
  }

  /**
   * Deletes all conflicting templates and re-queues their matched logs.
   */
  private async removeConflictingTemplates(params: {
    conflicts: Array<{ template: LogTemplateDefinition; samples: string[] }>;
    library: TemplateLibrary;
    libraryId: string;
    matchedRecords: MatchedLogRecord[];
  }): Promise<RegexLogEntry[]> {
    const { conflicts, library, libraryId, matchedRecords } = params;
    const templateIds = new Set<string>();
    let removedMatches = 0;
    const orphanedEntries: RegexLogEntry[] = [];

    for (const conflict of conflicts) {
      const templateId = conflict.template.id;
      if (!templateId || templateIds.has(templateId)) {
        continue;
      }
      templateIds.add(templateId);
      const orphaned = matchedRecords.filter((m) => m.template.id === templateId);
      removedMatches += orphaned.length;
      orphanedEntries.push(
        ...orphaned.map((m) => ({
          raw: m.raw,
          content: m.content,
          index: m.lineIndex ?? 0,
          headMatched: m.content !== undefined,
        })),
      );
    }

    if (templateIds.size === 0) {
      return orphanedEntries;
    }

    if (removedMatches > 0) {
      const kept = matchedRecords.filter((m) => !templateIds.has(m.template.id ?? ''));
      matchedRecords.splice(0, matchedRecords.length, ...kept);
      library.matchedSamples = library.matchedSamples.filter(
        (m) => !templateIds.has(m.template.id ?? ''),
      );
      this.deps.observer?.onExistingMatchSummary?.({
        matched: -removedMatches,
        unmatched: removedMatches,
      });
    }

    library.templates = library.templates.filter((t) => !templateIds.has(t.id ?? ''));
    for (const id of templateIds) {
      await this.deps.templateManager.deleteTemplate(libraryId, id);
    }

    return orphanedEntries;
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

  private async recordRefineTrace(
    lineIndex: number,
    rawLog: string,
    output: RefineAgentOutput,
    conflictingTemplate?: LogTemplateDefinition,
  ): Promise<void> {
    const coloredTemplate = colorizePlaceholders(output.template.placeholderTemplate);
    const displayRaw =
      typeof output.template.metadata?.['contentSample'] === 'string'
        ? (output.template.metadata?.['contentSample'] as string)
        : undefined;
    const coloredRaw = displayRaw ? colorizePlaceholders(displayRaw) ?? displayRaw : undefined;

    logConsole('info', 'refine-trace', [
      ['line', lineIndex],
      ['action', output.action],
      ['conflictWith', conflictingTemplate?.id],
      ['template', coloredTemplate],
      ['content', coloredRaw],
    ]);
  }

  private async recordFailure(
    lineIndex: number,
    rawLog: string,
    stage: string,
    reason: string,
    template?: LogTemplateDefinition,
    details?: Record<string, unknown>
  ): Promise<void> {
    const sanitizedTemplate: LogTemplateDefinition | undefined = template
      ? { ...template, pattern: undefined }
      : undefined;

    const failure: FailureRecord = {
      lineIndex,
      rawLog,
      stage,
      reason,
      timestamp: new Date().toISOString(),
      template: sanitizedTemplate,
      details,
    };
    this.failures.push(failure);
    this.deps.observer?.onFailure?.(failure);

    const diagnostics = (details as Record<string, unknown> | undefined)?.diagnostics as
      | Record<string, unknown>
      | undefined;

    const templateSource =
      sanitizedTemplate?.placeholderTemplate ??
      (typeof details?.['failedTemplate'] === 'string'
        ? (details['failedTemplate'] as string)
        : typeof diagnostics?.['failedTemplate'] === 'string'
          ? (diagnostics['failedTemplate'] as string)
          : undefined);

    const coloredTemplate = colorizePlaceholders(templateSource);
    const displayRaw =
      typeof details?.['contentUsed'] === 'string'
        ? (details['contentUsed'] as string)
        : typeof diagnostics?.['contentUsed'] === 'string'
          ? (diagnostics['contentUsed'] as string)
          : undefined;
    const reconstruction =
      typeof details?.['failedReconstruction'] === 'string'
        ? (details['failedReconstruction'] as string)
        : typeof diagnostics?.['failedReconstruction'] === 'string'
          ? (diagnostics['failedReconstruction'] as string)
          : undefined;
    const diff = diffStrings(displayRaw, reconstruction);
    const coloredRaw =
      diff.expected ??
      (displayRaw ? colorizePlaceholders(displayRaw) ?? displayRaw : undefined);
    const coloredReconstructed =
      diff.actual ??
      (reconstruction ? colorizePlaceholders(reconstruction) ?? reconstruction : undefined);
    const issues = Array.isArray(details?.['issues']) ? details?.['issues'] : undefined;
    logConsole('error', 'failure', [
      ['line', lineIndex],
      ['stage', stage],
      ['reason', reason],
      ['template', coloredTemplate],
      ['expected', coloredRaw],
      ['reconstructed', coloredReconstructed],
      ['issues', issues ? issues.join('; ') : undefined],
    ]);
  }

  private logStage(
    lineIndex: number,
    stage: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.deps.observer?.onStage?.({ lineIndex, stage, message, data });
  }

}
