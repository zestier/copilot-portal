// Pure scope-key derivation. Shared between the server (matcher) and the
// client (dialog UI), so it lives outside $lib/server.

/**
 * Derive a scope key from the SDK's permission-request payload. Returns
 * null if no meaningful scope can be extracted; the matcher will then
 * only fire for wildcard-pattern grants, and the dialog will gray out
 * the "Just this exact …" scope option.
 */
export function deriveScopeKey(
	permissionKind: string,
	req: {
		fullCommandText?: string;
		fileName?: string;
		args?: unknown;
	}
): string | null {
	switch (permissionKind) {
		case 'shell':
			return req.fullCommandText ?? readArgString(req.args, 'command') ?? null;
		case 'write':
		case 'edit':
		case 'read':
			return req.fileName ?? readArgString(req.args, 'path') ?? null;
		case 'url': {
			const url =
				readArgString(req.args, 'url') ?? readArgString(req.args, 'href') ?? req.fullCommandText;
			return url ?? null;
		}
		default:
			return null;
	}
}

function readArgString(args: unknown, key: string): string | null {
	if (!args || typeof args !== 'object') return null;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}
