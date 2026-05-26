import { expect, type APIRequestContext } from '@playwright/test';

interface ConversationPayload {
	activeTurnId: string | null;
	messages: Array<{ id: string; role: string; content: string }>;
	pendingInteractive: unknown[];
}

export async function createConversation(request: APIRequestContext, title: string) {
	const res = await request.post('/api/conversations', {
		data: { title }
	});
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return body.conversation.id as string;
}

export async function getConversation(request: APIRequestContext, conversationId: string) {
	return (await request
		.get(`/api/conversations/${conversationId}`)
		.then((r) => r.json())) as ConversationPayload;
}

export async function waitForAssistantMessage(
	request: APIRequestContext,
	conversationId: string,
	content: string | RegExp
) {
	await expect
		.poll(async () => {
			const body = await getConversation(request, conversationId);
			return (
				body.activeTurnId === null &&
				body.messages.some((message) => {
					if (message.role !== 'assistant') return false;
					return typeof content === 'string'
						? message.content === content
						: content.test(message.content);
				})
			);
		})
		.toBe(true);
	return getConversation(request, conversationId);
}

export async function waitForPendingInteractive(
	request: APIRequestContext,
	conversationId: string
) {
	await expect
		.poll(async () => {
			const body = await getConversation(request, conversationId);
			return body.pendingInteractive.length;
		})
		.toBeGreaterThan(0);
	return getConversation(request, conversationId);
}
