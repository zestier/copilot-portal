import { error } from '@sveltejs/kit';

/**
 * Default human-readable messages for the small set of error codes we use.
 * Routes can still pass an override message when something more specific
 * is useful (e.g., the Zod field path).
 */
const DEFAULT_MESSAGES: Record<string, string> = {
	bad_request: 'Bad request',
	unauthorized: 'Unauthorized',
	forbidden: 'Forbidden',
	bad_origin: 'Bad origin',
	not_found: 'Not found',
	conflict: 'Conflict',
	unprocessable: 'Unprocessable entity',
	rate_limited: 'Too many requests',
	internal: 'Internal server error'
};

/**
 * Throw a SvelteKit `error()` with a unified JSON body shape.
 *
 *   { message: string, code: string }
 *
 * Use this from `/api/*` route handlers so every rejection has the same
 * envelope. The hooks layer (`hooks.server.ts`) has its own equivalent
 * helper, `apiErrorResponse`, because hooks must build a `Response`
 * directly instead of throwing.
 */
export function apiError(status: number, code: string, message?: string): never {
	throw error(status, { message: message ?? DEFAULT_MESSAGES[code] ?? code, code });
}

/**
 * Build a `Response` for the same `{message, code}` body, for callers
 * (notably `hooks.server.ts`) that can't throw `error()`.
 */
export function apiErrorResponse(status: number, code: string, message?: string): Response {
	return new Response(
		JSON.stringify({ message: message ?? DEFAULT_MESSAGES[code] ?? code, code }),
		{
			status,
			headers: { 'content-type': 'application/json' }
		}
	);
}
