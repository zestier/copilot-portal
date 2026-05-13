import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
		environment: 'node'
	},
	server: {
		port: 5173,
		strictPort: false,
		// Allow the public hostname the dev server is reached through
		// (e.g. a Cloudflare tunnel). Set TUNNEL_HOST=foo.example.
		allowedHosts: process.env.TUNNEL_HOST ? [process.env.TUNNEL_HOST] : undefined
	},
	ssr: {
		// better-sqlite3 is native; never bundle it.
		external: ['better-sqlite3']
	}
});
