// SSE response helper: takes an async iterable of JSON-able events and
// returns a Response with the right headers. Sends a heartbeat comment
// every 15 s to keep proxies from idling the connection.
//
// Generic over the event payload type so callers (chat streams, redeploy,
// etc.) get type-checked events without each rebuilding the encoding /
// heartbeat / error-frame contract.

export function sseResponse<T>(events: AsyncIterable<T>): Response {
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
				for await (const ev of events) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
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
