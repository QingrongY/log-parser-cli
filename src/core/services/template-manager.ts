/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MatchedLogRecord,
  TemplateLibrary,
  TemplateManager,
} from '../types.js';
import type { LogTemplateDefinition } from '../../agents/index.js';

export class InMemoryTemplateManager implements TemplateManager {
  private readonly libraries = new Map<string, TemplateLibrary>();

  async listLibraries(): Promise<string[]> {
    return [...this.libraries.keys()];
  }

  async loadLibrary(id: string): Promise<TemplateLibrary> {
    if (!this.libraries.has(id)) {
      this.libraries.set(id, {
        id,
        templates: [],
        matchedSamples: [],
      });
    }
    // Non-null assertion is safe after ensure block.
    return this.libraries.get(id)!;
  }

  async saveTemplate(id: string, template: LogTemplateDefinition): Promise<LogTemplateDefinition> {
    const library = await this.loadLibrary(id);
    const nextTemplates = library.templates.filter((entry) => entry.id !== template.id);
    const assignedId = template.id ?? `${id}:${nextTemplates.length + 1}`;
    const templateWithId = {
      ...template,
      id: assignedId,
    };
    nextTemplates.push(templateWithId);
    this.libraries.set(id, {
      ...library,
      templates: nextTemplates,
    });
    return templateWithId;
  }

  async recordMatches(id: string, matches: MatchedLogRecord[]): Promise<void> {
    if (matches.length === 0) {
      return;
    }
    const library = await this.loadLibrary(id);
    this.libraries.set(id, {
      ...library,
      matchedSamples: [...library.matchedSamples, ...matches],
    });
  }
}
