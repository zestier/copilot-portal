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
		alias: {
			$lib: 'src/lib'
		}
	}
};

export default config;
