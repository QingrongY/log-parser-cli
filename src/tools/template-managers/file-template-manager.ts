/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  MatchedLogRecord,
  TemplateLibrary,
  TemplateManager,
} from '../../core/index.js';
import type { LogTemplateDefinition, HeadPatternDefinition } from '../../agents/index.js';
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from '../files.js';

export interface FileTemplateManagerOptions {
  baseDir: string;
  maxStoredMatches?: number;
}

interface PersistedLibrary extends TemplateLibrary {}

export class FileTemplateManager implements TemplateManager {
  private readonly baseDir: string;
  private readonly maxStoredMatches: number;

  constructor(options: FileTemplateManagerOptions) {
    this.baseDir = options.baseDir;
    this.maxStoredMatches = options.maxStoredMatches ?? 1000;
  }

  async listLibraries(): Promise<string[]> {
    await ensureDirectory(this.baseDir);
    const entries = await fs.readdir(this.baseDir);
    return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.replace(/\.json$/, ''));
  }

  async loadLibrary(id: string): Promise<TemplateLibrary> {
    const filePath = this.resolvePath(id);
    if (!(await fileExists(filePath))) {
      return { id, templates: [], matchedSamples: [], nextTemplateNumber: 1 };
    }
    const persisted = await readJsonFile<PersistedLibrary>(filePath);
    return {
      id: persisted.id ?? id,
      templates: persisted.templates ?? [],
      matchedSamples: persisted.matchedSamples ?? [],
      headPattern: persisted.headPattern,
      nextTemplateNumber:
        persisted.nextTemplateNumber ??
        this.estimateNextTemplateNumber(persisted.templates ?? []),
    };
  }

  async saveTemplate(id: string, template: LogTemplateDefinition): Promise<LogTemplateDefinition> {
    const library = await this.loadLibrary(id);
    const nextTemplates = library.templates.filter((entry) => entry.id !== template.id);
    const identifier =
      template.id ??
      `${id}#${library.nextTemplateNumber ?? this.estimateNextTemplateNumber(library.templates)}`;
    const templateWithId = { ...template, id: identifier };
    nextTemplates.push(templateWithId);
    const nextLibrary: TemplateLibrary = {
      ...library,
      templates: nextTemplates,
      nextTemplateNumber: this.estimateNextTemplateNumber(nextTemplates),
    };
    await this.persistLibrary(id, nextLibrary);
    return templateWithId;
  }

  async deleteTemplate(libraryId: string, templateId: string): Promise<void> {
    const library = await this.loadLibrary(libraryId);
    const nextTemplates = library.templates.filter((t) => t.id !== templateId);
    const nextLibrary: TemplateLibrary = {
      ...library,
      templates: nextTemplates,
    };
    await this.persistLibrary(libraryId, nextLibrary);
  }

  async recordMatches(id: string, matches: MatchedLogRecord[]): Promise<void> {
    if (matches.length === 0) {
      return;
    }
    const library = await this.loadLibrary(id);
    const combined = [...library.matchedSamples, ...matches];
    const trimmed = combined.slice(-this.maxStoredMatches);
    const nextLibrary: TemplateLibrary = {
      ...library,
      matchedSamples: trimmed,
    };
    await this.persistLibrary(id, nextLibrary);
  }

  private resolvePath(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  async saveHeadPattern(id: string, head: HeadPatternDefinition): Promise<void> {
    const library = await this.loadLibrary(id);
    const nextLibrary: TemplateLibrary = {
      ...library,
      headPattern: head,
    };
    await this.persistLibrary(id, nextLibrary);
  }

  private async persistLibrary(id: string, library: TemplateLibrary): Promise<void> {
    const filePath = this.resolvePath(id);
    await writeJsonFile(filePath, library);
  }

  private estimateNextTemplateNumber(templates: LogTemplateDefinition[] = []): number {
    let maxValue = 0;
    for (const template of templates) {
      const suffix = this.extractNumericSuffix(template.id);
      if (suffix !== undefined && suffix > maxValue) {
        maxValue = suffix;
      }
    }
    return maxValue + 1;
  }

  private extractNumericSuffix(templateId?: string): number | undefined {
    if (!templateId) {
      return undefined;
    }
    const match = templateId.match(/#(\d+)$/);
    if (!match) {
      return undefined;
    }
    return Number.parseInt(match[1], 10);
  }
}
