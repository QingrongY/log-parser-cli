/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import initSqlJs from 'sql.js';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { ensureDirectory } from './io/files.js';
import type {
  MatchedLogRecord,
  TemplateLibrary,
  TemplateManager,
} from '../core/index.js';
import type { LogTemplateDefinition } from '../agents/index.js';

const SQL = await initSqlJs();
type SqlJsDatabase = InstanceType<typeof SQL.Database>;
const SQLITE_EXTENSION = '.sqlite';

export interface SqliteTemplateManagerOptions {
  baseDir: string;
  maxStoredMatches?: number;
}

interface TemplateRow {
  id: string;
  placeholderTemplate: string;
  placeholderVariables?: string;
  metadata?: string;
}

interface MatchRow {
  raw: string;
  matchVariables?: string;
  templateId?: string;
  templatePlaceholderTemplate?: string;
  templatePlaceholderVariables?: string;
  templateMetadata?: string;
}

export function getLibraryDatabasePath(baseDir: string, libraryId: string): string {
  return join(baseDir, `${encodeURIComponent(libraryId)}${SQLITE_EXTENSION}`);
}

interface DbHandle {
  db: SqlJsDatabase;
  path: string;
}

export class SqliteTemplateManager implements TemplateManager {
  private readonly baseDir: string;
  private readonly maxStoredMatches: number;
  private readonly handles = new Map<string, DbHandle>();

  constructor(options: SqliteTemplateManagerOptions) {
    this.baseDir = options.baseDir;
    ensureDirectory(this.baseDir);
    this.maxStoredMatches = options.maxStoredMatches ?? 1000;
  }

  async listLibraries(): Promise<string[]> {
    ensureDirectory(this.baseDir);
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
      .map((entry) => this.fromFileName(entry.name))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
    return ids;
  }

  async loadLibrary(id: string): Promise<TemplateLibrary> {
    const handle = this.getHandle(id);
    this.ensureLibraryRecord(handle, id);
    const templates = this.loadTemplates(handle, id);
    const matchedSamples = this.loadMatchedSamples(handle, id);
    const nextTemplateNumber = this.getNextTemplateNumber(handle, id);
    return {
      id,
      templates,
      matchedSamples,
      nextTemplateNumber,
    };
  }

  async saveTemplate(id: string, template: LogTemplateDefinition): Promise<LogTemplateDefinition> {
    const handle = this.getHandle(id);
    this.ensureLibraryRecord(handle, id);
    let assignedId = template.id;
    if (!assignedId) {
      assignedId = `${id}#${this.getNextTemplateNumber(handle, id)}`;
      this.incrementTemplateNumber(handle, id);
    }
    const placeholderVariables = JSON.stringify(template.placeholderVariables ?? {});
    const metadata = template.metadata ? JSON.stringify(template.metadata) : null;
    const stmt = handle.db.prepare(
      `INSERT INTO log_templates (id, library_id, placeholderTemplate, placeholderVariables, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET placeholderTemplate=excluded.placeholderTemplate, placeholderVariables=excluded.placeholderVariables, metadata=excluded.metadata`,
    );
    stmt.bind([assignedId, id, template.placeholderTemplate, placeholderVariables, metadata]);
    stmt.step();
    stmt.free();
    this.persist(handle);
    return { ...template, id: assignedId };
  }

  async recordMatches(id: string, matches: MatchedLogRecord[]): Promise<void> {
    if (matches.length === 0) {
      return;
    }
    const handle = this.getHandle(id);
    const insert = handle.db.prepare(
      `INSERT INTO matched_samples (library_id, template_id, raw, variables)
       VALUES (?, ?, ?, ?)`,
    );
    handle.db.exec('BEGIN');
    try {
      for (const match of matches) {
        const variablesJson = match.variables ? JSON.stringify(match.variables) : null;
        insert.bind([id, match.template?.id ?? null, match.raw, variablesJson]);
        insert.step();
        insert.reset();
      }
      this.trimMatches(handle, id);
      handle.db.exec('COMMIT');
    } catch (error) {
      handle.db.exec('ROLLBACK');
      insert.free();
      throw error;
    }
    insert.free();
    this.persist(handle);
  }

  private getHandle(libraryId: string): DbHandle {
    let handle = this.handles.get(libraryId);
    if (handle) {
      return handle;
    }
    const filePath = getLibraryDatabasePath(this.baseDir, libraryId);
    ensureDirectory(dirname(filePath));
    const { db, existed } = this.loadDatabase(filePath);
    this.setup(db);
    handle = { db, path: filePath };
    this.handles.set(libraryId, handle);
    if (!existed) {
      this.persist(handle);
    }
    return handle;
  }

  private loadDatabase(filePath: string): { db: SqlJsDatabase; existed: boolean } {
    if (existsSync(filePath)) {
      const buffer = readFileSync(filePath);
      return { db: new SQL.Database(buffer), existed: true };
    }
    return { db: new SQL.Database(), existed: false };
  }

  private setup(db: SqlJsDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS template_libraries (
        id TEXT PRIMARY KEY,
        next_template_number INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS log_templates (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        placeholderTemplate TEXT NOT NULL,
        placeholderVariables TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS matched_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id TEXT NOT NULL,
        template_id TEXT,
        raw TEXT NOT NULL,
        variables TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
  }

  private ensureLibraryRecord(handle: DbHandle, id: string): void {
    const stmt = handle.db.prepare(
      'INSERT INTO template_libraries (id) VALUES (?) ON CONFLICT(id) DO NOTHING',
    );
    stmt.bind([id]);
    stmt.step();
    stmt.free();
    this.persist(handle);
  }

  private loadTemplates(handle: DbHandle, libraryId: string): LogTemplateDefinition[] {
    const stmt = handle.db.prepare(
      `SELECT id,
              placeholderTemplate,
              placeholderVariables,
              metadata
       FROM log_templates
       WHERE library_id = ?
       ORDER BY created_at ASC`,
    );
    stmt.bind([libraryId]);
    const templates: LogTemplateDefinition[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as TemplateRow;
      templates.push({
        id: row.id,
        placeholderTemplate: row.placeholderTemplate,
        placeholderVariables: parseJsonObject(row.placeholderVariables),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }
    stmt.free();
    return templates;
  }

  private loadMatchedSamples(handle: DbHandle, libraryId: string): MatchedLogRecord[] {
    const stmt = handle.db.prepare(
      `SELECT ms.raw AS raw,
              ms.variables AS matchVariables,
              lt.id AS templateId,
              lt.placeholderTemplate AS templatePlaceholderTemplate,
              lt.placeholderVariables AS templatePlaceholderVariables,
              lt.metadata AS templateMetadata
       FROM matched_samples ms
       LEFT JOIN log_templates lt ON lt.id = ms.template_id
       WHERE ms.library_id = ?
       ORDER BY ms.id DESC
       LIMIT ?`,
    );
    stmt.bind([libraryId, this.maxStoredMatches]);
    const samples: MatchedLogRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as MatchRow;
      const template: LogTemplateDefinition = row.templateId
        ? {
            id: row.templateId,
            placeholderTemplate: row.templatePlaceholderTemplate ?? '',
            placeholderVariables: parseJsonObject(row.templatePlaceholderVariables),
            metadata: row.templateMetadata ? JSON.parse(row.templateMetadata) : undefined,
          }
        : {
            placeholderTemplate: '',
            placeholderVariables: {},
          };
      samples.push({
        raw: row.raw,
        template,
        variables: parseJsonObject(row.matchVariables),
      });
    }
    stmt.free();
    return samples;
  }

  private getNextTemplateNumber(handle: DbHandle, libraryId: string): number {
    const stmt = handle.db.prepare(
      'SELECT next_template_number FROM template_libraries WHERE id = ?',
    );
    stmt.bind([libraryId]);
    stmt.step();
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return Number(row['next_template_number'] ?? 1);
  }

  private incrementTemplateNumber(handle: DbHandle, libraryId: string): void {
    handle.db.exec(
      `UPDATE template_libraries
       SET next_template_number = next_template_number + 1
       WHERE id = '${libraryId.replace(/'/g, "''")}'`,
    );
    this.persist(handle);
  }

  private trimMatches(handle: DbHandle, libraryId: string): void {
    const stmt = handle.db.prepare(
      'SELECT COUNT(*) as count FROM matched_samples WHERE library_id = ?',
    );
    stmt.bind([libraryId]);
    stmt.step();
    const count = Number((stmt.getAsObject() as { count: number }).count ?? 0);
    stmt.free();
    const overflow = Math.max(0, count - this.maxStoredMatches);
    if (overflow > 0) {
      const deleteStmt = handle.db.prepare(
        `DELETE FROM matched_samples
         WHERE id IN (
           SELECT id FROM matched_samples
           WHERE library_id = ?
           ORDER BY id ASC
           LIMIT ?
         )`,
      );
      deleteStmt.bind([libraryId, overflow]);
      deleteStmt.step();
      deleteStmt.free();
    }
  }

  private persist(handle: DbHandle): void {
    const data = handle.db.export();
    writeFileSync(handle.path, Buffer.from(data));
  }

  private fromFileName(name: string): string | undefined {
    if (!name.endsWith(SQLITE_EXTENSION)) {
      return undefined;
    }
    const encoded = name.slice(0, -SQLITE_EXTENSION.length);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
}

function parseJsonObject(value?: string): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
