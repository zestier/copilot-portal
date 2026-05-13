// Stream POST + SSE: yields parsed JSON events from a `data:` SSE response.

export async function* streamSse<T>(
	url: string,
	init: RequestInit & { signal?: AbortSignal } = {}
): AsyncIterable<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		throw new Error(`SSE fetch failed: ${res.status}`);
	}
	// 204 / empty body: nothing to stream.
	if (res.status === 204 || !res.body) return;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const lines = raw.split('\n');
				const dataLines: string[] = [];
				for (const line of lines) {
					if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
				}
				if (dataLines.length === 0) continue; // comment / heartbeat
				const payload = dataLines.join('\n');
				try {
					yield JSON.parse(payload) as T;
				} catch {
					/* ignore malformed */
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* ignore */
		}
	}
}

export function csrfToken(): string {
	if (typeof document === 'undefined') return '';
	const m = document.querySelector('meta[name="csrf-token"]');
	return m?.getAttribute('content') ?? '';
}
