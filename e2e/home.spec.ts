import { test, expect } from '@playwright/test';

test('home page renders and creates a new conversation', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: "Zestier's AI Portal" })).toBeVisible();

	const newChat = page.getByRole('button', { name: /\+ New chat/ }).first();
	await expect(newChat).toBeEnabled();
	await newChat.click();

	await page.waitForURL(/\/conversations\/[A-Z0-9]+/);
	await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
});

test('health endpoint is public', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true });
});
