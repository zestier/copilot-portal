import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// When TUNNEL_HOST is set the request's Host header won't match what the
// server thinks its origin is, so SvelteKit's same-origin POST check would
// reject every form submission. Disable it in that case; SameSite=Lax
// session cookies still block cross-site CSRF.
const tunneling = !!process.env.TUNNEL_HOST;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ out: 'build' }),
		csrf: tunneling ? { trustedOrigins: ['*'] } : {},
		// CSP for HTML responses. Hash mode lets SvelteKit emit integrity
		// hashes for the inline hydration <script> blocks it generates,
		// so we can drop `'unsafe-inline'` from script-src. The matching
		// header for non-HTML responses (API JSON, SSE, etc.) is set in
		// src/hooks.server.ts; both must stay in sync.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'connect-src': ['self'],
				'img-src': ['self', 'data:', 'https://avatars.githubusercontent.com'],
				'font-src': ['self', 'data:'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self']
			}
		},
		alias: {
			$lib: 'src/lib'
		}
	}
};

export default config;
