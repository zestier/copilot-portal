// SQLite singleton + migrations.

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { log } from '../log';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
	if (dbInstance) return dbInstance;
	const cfg = loadConfig();
	const dataDir = resolve(cfg.DATA_DIR);
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, 'portal.db');
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');
	runMigrations(db);
	dbInstance = db;
	log.info('db.open', { path });
	return db;
}

function migrationsDir(): string {
	// At runtime under SvelteKit/Vite, import.meta.url points into compiled output.
	// Try alongside this file first; fall back to source path during dev.
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, 'migrations'),
		join(here, '..', 'migrations'),
		resolve(process.cwd(), 'src/lib/server/db/migrations')
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	throw new Error('Could not locate db migrations directory');
}

function runMigrations(db: Database.Database) {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`);
	const applied = new Set<number>(
		db
			.prepare('SELECT version FROM schema_migrations')
			.all()
			.map((r: unknown) => (r as { version: number }).version)
	);

	const dir = migrationsDir();
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const m = file.match(/^(\d+)_/);
		if (!m) continue;
		const version = parseInt(m[1], 10);
		if (applied.has(version)) continue;
		const sql = readFileSync(join(dir, file), 'utf8');
		const tx = db.transaction(() => {
			db.exec(sql);
			db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
				version,
				Date.now()
			);
		});
		tx();
		log.info('db.migration.applied', { version, file });
	}
}

export function closeDb() {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = null;
	}
}
