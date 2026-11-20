/**
 * Storage of one imported world in one SQLite file.
 *
 * Each entity is a row holding its JSON, keyed by kind and ID number, so that
 * lists come back in ID order. The world's own description and the import
 * report sit in a small key/value table.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  type EntityKind,
  type ImportReport,
  type World,
  ImportReportSchema,
  WorldSchema,
  idNumber,
} from '@worldsim/core';

/** Raised when the file holds no world, or one written in another layout. */
export class WorldStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldStoreError';
  }
}

/** Bump when the stored layout or the world format changes shape. */
const STORAGE_VERSION = '2';

const LISTS = {
  cell: 'cells',
  state: 'states',
  province: 'provinces',
  culture: 'cultures',
  religion: 'religions',
  river: 'rivers',
  route: 'routes',
  settlement: 'settlements',
} as const satisfies Record<EntityKind, keyof World>;

const KINDS = Object.keys(LISTS) as EntityKind[];

export class WorldStore {
  private readonly db: Database.Database;

  /** Opens the file, creating it and its folder if needed. Use ":memory:" for a throwaway store. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS entity (
        kind   TEXT    NOT NULL,
        number INTEGER NOT NULL,
        id     TEXT    NOT NULL UNIQUE,
        data   TEXT    NOT NULL,
        PRIMARY KEY (kind, number)
      ) WITHOUT ROWID;
    `);
  }

  /** Replaces whatever the file holds with this world, all or nothing. */
  save(world: World, report: ImportReport): void {
    const setMeta = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    const addEntity = this.db.prepare('INSERT INTO entity (kind, number, id, data) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      this.db.exec('DELETE FROM entity; DELETE FROM meta;');
      setMeta.run('storage_version', STORAGE_VERSION);
      setMeta.run('info', JSON.stringify(world.info));
      setMeta.run('report', JSON.stringify(report));
      for (const kind of KINDS) {
        for (const entity of world[LISTS[kind]]) {
          addEntity.run(kind, idNumber(entity.id), entity.id, JSON.stringify(entity));
        }
      }
    })();
  }

  hasWorld(): boolean {
    return this.meta('info') !== undefined;
  }

  /** The whole stored world, checked against the world format. */
  loadWorld(): World {
    this.requireWorld();
    const list = (kind: EntityKind): unknown[] =>
      this.db
        .prepare<[string], { data: string }>('SELECT data FROM entity WHERE kind = ? ORDER BY number')
        .all(kind)
        .map((row) => JSON.parse(row.data));
    const stored: Record<string, unknown> = { info: JSON.parse(this.meta('info') as string) };
    for (const kind of KINDS) stored[LISTS[kind]] = list(kind);
    const world = WorldSchema.safeParse(stored);
    if (!world.success) {
      throw new WorldStoreError(`the stored world does not fit the world format; import it again (${world.error.issues[0]?.message})`);
    }
    return world.data;
  }

  loadReport(): ImportReport {
    this.requireWorld();
    return ImportReportSchema.parse(JSON.parse(this.meta('report') as string));
  }

  /** Every stored row as text, in a fixed order. Two stores with equal dumps hold identical data. */
  dump(): string {
    const meta = this.db.prepare('SELECT key, value FROM meta ORDER BY key').all();
    const entities = this.db.prepare('SELECT kind, number, id, data FROM entity ORDER BY kind, number').all();
    return JSON.stringify({ meta, entities });
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | undefined {
    return this.db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  }

  private requireWorld(): void {
    if (!this.hasWorld()) {
      throw new WorldStoreError('the store holds no world yet; import one first');
    }
    const version = this.meta('storage_version');
    if (version !== STORAGE_VERSION) {
      throw new WorldStoreError(`the store was written in layout ${version}, this server reads layout ${STORAGE_VERSION}; import the world again`);
    }
  }
}
