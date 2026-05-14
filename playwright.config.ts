import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, 'e2e/.tmp-data');

// Fresh DATA_DIR every run so tests start from an empty SQLite db.
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.E2E_PORT ?? 4173);
const buildEntry = resolve(__dirname, 'build');

export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
	timeout: 30_000,
	expect: { timeout: 5_000 },
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	webServer: {
		command: `node ${JSON.stringify(buildEntry)}`,
		url: `http://127.0.0.1:${PORT}/api/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: dataDir,
		env: {
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(PORT),
			DATA_DIR: dataDir,
			AUTH_MODE: 'none',
			I_KNOW_THIS_IS_LOCAL: '1',
			ENCRYPTION_KEY: randomBytes(32).toString('base64'),
			COPILOT_STUB: '1',
			LOG_LEVEL: 'warn',
			DB_MIGRATIONS_DIR: resolve(__dirname, 'src/lib/server/db/migrations'),
			// dataDir lives inside the copilot-portal source tree, which is itself a
			// git repo. Without this, the server's workspaceRoot (=dataDir) would
			// inherit the outer repo when running `git` commands. Tell git to stop
			// walking at dataDir so each test sees an isolated workspace.
			GIT_CEILING_DIRECTORIES: dataDir
		}
	}
});
