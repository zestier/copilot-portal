import { ulid } from 'ulid';
import { getDb } from '../index';
import type { User } from '$lib/types';

interface UserRow {
	id: string;
	github_login: string;
	github_id: number | null;
	display_name: string | null;
	avatar_url: string | null;
	created_at: number;
	last_login_at: number | null;
}

function rowToUser(r: UserRow): User {
	return {
		id: r.id,
		githubLogin: r.github_login,
		displayName: r.display_name,
		avatarUrl: r.avatar_url
	};
}

export function getById(id: string): User | null {
	const r = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
	return r ? rowToUser(r) : null;
}

export function getByGithubLogin(login: string): User | null {
	const r = getDb().prepare('SELECT * FROM users WHERE github_login = ?').get(login) as
		| UserRow
		| undefined;
	return r ? rowToUser(r) : null;
}

export interface UpsertGithubInput {
	githubLogin: string;
	githubId: number;
	displayName: string | null;
	avatarUrl: string | null;
}

export function upsertGithub(input: UpsertGithubInput): User {
	const db = getDb();
	const existing = db
		.prepare('SELECT * FROM users WHERE github_id = ? OR github_login = ?')
		.get(input.githubId, input.githubLogin) as UserRow | undefined;
	const now = Date.now();
	if (existing) {
		db.prepare(
			`UPDATE users SET github_login = ?, github_id = ?, display_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?`
		).run(input.githubLogin, input.githubId, input.displayName, input.avatarUrl, now, existing.id);
		return rowToUser({
			...existing,
			github_login: input.githubLogin,
			github_id: input.githubId,
			display_name: input.displayName,
			avatar_url: input.avatarUrl,
			last_login_at: now
		});
	}
	const id = ulid();
	db.prepare(
		`INSERT INTO users(id, github_login, github_id, display_name, avatar_url, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, input.githubLogin, input.githubId, input.displayName, input.avatarUrl, now, now);
	return {
		id,
		githubLogin: input.githubLogin,
		displayName: input.displayName,
		avatarUrl: input.avatarUrl
	};
}

/**
 * Idempotently get-or-create the single local user used in AUTH_MODE=none.
 */
export function ensureLocalUser(): User {
	const db = getDb();
	const existing = db.prepare('SELECT * FROM users WHERE github_login = ?').get('local') as
		| UserRow
		| undefined;
	if (existing) return rowToUser(existing);
	const id = ulid();
	const now = Date.now();
	db.prepare(
		`INSERT INTO users(id, github_login, display_name, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?)`
	).run(id, 'local', 'Local user', now, now);
	return { id, githubLogin: 'local', displayName: 'Local user', avatarUrl: null };
}
