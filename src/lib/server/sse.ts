// SSE response helper: takes an async iterable of JSON-able events and
// returns a Response with the right headers. Sends a heartbeat comment
// every 15 s to keep proxies from idling the connection.
//
// Generic over the event payload type so callers (chat streams, redeploy,
// etc.) get type-checked events without each rebuilding the encoding /
// heartbeat / error-frame contract.
//
// Two emission modes:
//   - Default: each iterable item is serialized whole as JSON in a single
//     `data:` line. Used by the redeploy stream.
//   - Id-tagged: pass `{ extractId, extractData }` to write a per-event
//     `id:` line so browsers populate the `Last-Event-ID` header on
//     auto-reconnect. Used by the chat turn stream.

export interface SseResponseOptions<T> {
	// Returns the event's monotonic id (or undefined to skip the id line).
	extractId?: (item: T) => number | string | undefined;
	// Returns the JSON payload to serialize. Defaults to the item itself.
	extractData?: (item: T) => unknown;
}

export function sseResponse<T>(
	events: AsyncIterable<T>,
	opts: SseResponseOptions<T> = {}
): Response {
	const { extractId, extractData } = opts;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
				} catch {
					/* closed */
				}
			}, 15_000);
			(heartbeat as { unref?: () => void }).unref?.();
			try {
				for await (const item of events) {
					const id = extractId?.(item);
					const data = extractData ? extractData(item) : item;
					let frame = '';
					if (id !== undefined) frame += `id: ${id}\n`;
					frame += `data: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(frame));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: 'error', code: 'stream_failed', message })}\n\n`
					)
				);
			} finally {
				clearInterval(heartbeat);
				controller.close();
			}
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
}
