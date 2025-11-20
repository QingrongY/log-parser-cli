/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogTemplateDefinition } from '../../agents/index.js';
import type { MatchedLogRecord } from '../types.js';

export interface RegexLogEntry {
  raw: string;
  index: number;
}

export interface RegexMatchRequest {
  logs: RegexLogEntry[];
  templates: LogTemplateDefinition[];
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

    for (const chunk of chunks) {
      for (const entry of chunk) {
        const record = this.matchSingle(entry, request.templates);
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
  ): MatchedLogRecord | undefined {
    for (const template of templates) {
      try {
        const regex = new RegExp(template.pattern);
        const match = regex.exec(entry.raw);
        if (!match) {
          continue;
        }
        return {
          raw: entry.raw,
          lineIndex: entry.index,
          template,
          variables: this.extractVariables(match, template.variables ?? []),
        };
      } catch (error) {
        // eslint-disable-next-line no-console -- placeholder diagnostics until workers land.
        console.warn('Failed to evaluate template', template.pattern, error);
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
}
