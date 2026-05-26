export interface SseEvent {
	event: string | null;
	data: string;
}

export async function parseJson(res: Response): Promise<unknown> {
	return await res.json().catch(() => ({}));
}

export function jsonRequestHeaders(apiKey?: string | null): HeadersInit {
	const headers: Record<string, string> = {
		'content-type': 'application/json'
	};
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	return headers;
}

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const timeout = new AbortController();
	const handle = setTimeout(() => {
		timeout.abort(new DOMException(`Request timed out after ${timeoutMs}ms.`, 'TimeoutError'));
	}, timeoutMs);
	const { signal, cleanup } = combineAbortSignals(init.signal, timeout.signal);
	try {
		return await fetch(input, { ...init, signal });
	} finally {
		clearTimeout(handle);
		cleanup();
	}
}

function combineAbortSignals(
	existing: AbortSignal | null | undefined,
	timeout: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
	if (!existing) return { signal: timeout, cleanup: () => undefined };
	const combined = new AbortController();
	const abortFromExisting = () => combined.abort(existing.reason);
	const abortFromTimeout = () => combined.abort(timeout.reason);
	if (existing.aborted) abortFromExisting();
	if (timeout.aborted) abortFromTimeout();
	existing.addEventListener('abort', abortFromExisting, { once: true });
	timeout.addEventListener('abort', abortFromTimeout, { once: true });
	return {
		signal: combined.signal,
		cleanup: () => {
			existing.removeEventListener('abort', abortFromExisting);
			timeout.removeEventListener('abort', abortFromTimeout);
		}
	};
}

export async function* streamSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
	for await (const event of streamSseEvents(body)) {
		yield event.data;
	}
}

export async function* streamSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let eventName: string | null = null;
	let dataLines: string[] = [];

	function drainLine(line: string): SseEvent | null {
		const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (trimmed === '') {
			if (dataLines.length === 0) {
				eventName = null;
				return null;
			}
			const event = { event: eventName, data: dataLines.join('\n') };
			eventName = null;
			dataLines = [];
			return event;
		}
		if (trimmed.startsWith(':')) return null;
		const separator = trimmed.indexOf(':');
		const field = separator === -1 ? trimmed : trimmed.slice(0, separator);
		const value = separator === -1 ? '' : trimmed.slice(separator + 1).replace(/^ /, '');
		if (field === 'event') eventName = value;
		if (field === 'data') dataLines.push(value);
		return null;
	}

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf('\n');
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const event = drainLine(line);
				if (event) yield event;
				newline = buffer.indexOf('\n');
			}
		}
		buffer += decoder.decode();
		if (buffer) {
			const event = drainLine(buffer);
			if (event) yield event;
		}
		if (dataLines.length > 0) yield { event: eventName, data: dataLines.join('\n') };
	} finally {
		reader.releaseLock();
	}
}
