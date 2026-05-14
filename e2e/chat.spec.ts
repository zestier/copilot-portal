import { test, expect } from '@playwright/test';

async function createConversation(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/conversations', {
		data: { title: 'E2E chat' }
	});
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return body.conversation.id as string;
}

test('streamed assistant reply (stubbed) appears and persists across reloads', async ({
	page,
	request
}) => {
	const id = await createConversation(request);
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message Copilot/);
	await composer.click();
	await composer.fill('hello world');
	await composer.press('Enter');

	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible({
		timeout: 10_000
	});

	// Reload and confirm both the user message and the assistant reply were
	// persisted (proves the turn-runner wrote them to SQLite).
	await page.reload();
	await expect(page.getByText('hello world', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible();
});

test('rejects empty messages on the server', async ({ request }) => {
	const id = await createConversation(request);
	const res = await request.post(`/api/conversations/${id}/turns`, {
		data: { content: '' }
	});
	expect(res.ok()).toBeFalsy();
});
