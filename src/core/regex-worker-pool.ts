/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition } from '../agents/index.js';
import { buildRegexFromTemplate } from '../common/regex-builder.js';
import type { MatchedLogRecord } from './types.js';
import type { HeadPatternDefinition } from '../agents/types.js';
import { extractContentWithHead } from './head-pattern.js';

export interface RegexLogEntry {
  raw: string;
  index: number;
  content?: string;
  headMatched?: boolean;
}

export interface RegexMatchRequest {
  logs: RegexLogEntry[];
  templates: LogTemplateDefinition[];
  headPattern?: HeadPatternDefinition;
}

export interface RegexMatchResult {
  matched: MatchedLogRecord[];
  unmatched: RegexLogEntry[];
}

export interface RegexWorkerPoolOptions {
  concurrency?: number;
}

/**
 * Placeholder worker pool that currently executes regex matching synchronously.
 */
export class RegexWorkerPool {
  constructor(private readonly options: RegexWorkerPoolOptions = {}) {}

  async match(request: RegexMatchRequest): Promise<RegexMatchResult> {
    const matched: MatchedLogRecord[] = [];
    const unmatched: RegexLogEntry[] = [];

    const concurrency = Math.max(1, this.options.concurrency ?? 1);
    const chunkSize = Math.max(1, Math.ceil(request.logs.length / concurrency));
    const chunks = this.chunkLogs(request.logs, chunkSize);
    const headRuntime = this.buildHeadRuntime(request.headPattern);

    for (const chunk of chunks) {
      for (const entry of chunk) {
        const record = this.matchSingle(entry, request.templates, headRuntime);
        if (record) {
          matched.push(record);
        } else {
          unmatched.push(entry);
        }
      }
    }

    return { matched, unmatched };
  }

  private matchSingle(
    entry: RegexLogEntry,
    templates: LogTemplateDefinition[],
    headRuntime?: { regex: RegExp; head: HeadPatternDefinition },
  ): MatchedLogRecord | undefined {
    for (const template of templates) {
      try {
        if (!template.placeholderTemplate) {
          continue;
        }
        const { pattern, variables } = buildRegexFromTemplate(
          template.placeholderTemplate,
          template.placeholderVariables ?? {},
        );
        const regex = new RegExp(pattern);
        const targetText = this.selectTargetText(entry, template, headRuntime);
        if (targetText === undefined) {
          continue;
        }
        const match = regex.exec(targetText);
        if (!match) {
          continue;
        }
        return {
          raw: entry.raw,
          content: targetText === entry.raw ? undefined : targetText,
          lineIndex: entry.index,
          template,
          variables: this.extractVariables(match, variables ?? []),
        };
      } catch (error) {
        // eslint-disable-next-line no-console -- placeholder diagnostics until workers land.
        console.warn('Failed to evaluate template', error);
      }
    }
    return undefined;
  }

  private extractVariables(
    match: RegExpExecArray,
    variableNames: string[],
  ): Record<string, string> {
    const variables: Record<string, string> = {};
    for (const name of variableNames) {
      const value = match.groups?.[name] ?? this.findByIndex(match, variableNames.indexOf(name));
      if (value) {
        variables[name] = value;
      }
    }
    return variables;
  }

  private findByIndex(match: RegExpExecArray, index: number): string | undefined {
    const value = match[index + 1];
    return value === undefined ? undefined : value;
  }

  private chunkLogs(logs: RegexLogEntry[], size: number): RegexLogEntry[][] {
    if (size >= logs.length) {
      return [logs];
    }
    const result: RegexLogEntry[][] = [];
    for (let i = 0; i < logs.length; i += size) {
      result.push(logs.slice(i, i + size));
    }
    return result;
  }

  private buildHeadRuntime(
    head?: HeadPatternDefinition,
  ): { regex: RegExp; head: HeadPatternDefinition } | undefined {
    if (!head?.pattern) {
      return undefined;
    }
    try {
      const regex = new RegExp(head.pattern);
      return { regex, head };
    } catch {
      return undefined;
    }
  }

  private selectTargetText(
    entry: RegexLogEntry,
    template: LogTemplateDefinition,
    headRuntime?: { regex: RegExp; head: HeadPatternDefinition },
  ): string | undefined {
    const contentOnly = Boolean(template.metadata?.['contentOnly']);
    if (!contentOnly) {
      return entry.raw;
    }
    if (!headRuntime) {
      return undefined;
    }
    if (entry.content !== undefined && entry.headMatched) {
      return entry.content;
    }
    const extracted = extractContentWithHead(entry.raw, headRuntime.head, headRuntime.regex);
    if (!extracted.matched) {
      return undefined;
    }
    return extracted.content;
  }
}
