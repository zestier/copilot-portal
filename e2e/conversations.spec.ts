import { test, expect } from '@playwright/test';

test('conversation CRUD via API matches sidebar state', async ({ page, request }) => {
	const a = await request
		.post('/api/conversations', { data: { title: 'Alpha' } })
		.then((r) => r.json());
	const b = await request
		.post('/api/conversations', { data: { title: 'Beta' } })
		.then((r) => r.json());

	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: /Conversations/ });
	await expect(sidebar.getByText('Alpha')).toBeVisible();
	await expect(sidebar.getByText('Beta')).toBeVisible();

	const renameRes = await request.patch(`/api/conversations/${a.conversation.id}`, {
		data: { title: 'Alpha renamed' }
	});
	expect(renameRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText('Alpha renamed')).toBeVisible();

	const archiveRes = await request.patch(`/api/conversations/${b.conversation.id}`, {
		data: { archived: true }
	});
	expect(archiveRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText('Beta')).not.toBeVisible();
	await sidebar.getByRole('button', { name: /Archived/ }).click();
	await expect(sidebar.getByText('Beta')).toBeVisible();

	const delRes = await request.delete(`/api/conversations/${a.conversation.id}`);
	expect(delRes.ok()).toBeTruthy();
	await page.reload();
	await expect(sidebar.getByText('Alpha renamed')).not.toBeVisible();

	const getRes = await request.get(`/api/conversations/${a.conversation.id}`);
	expect(getRes.status()).toBe(404);
});

test('rename via sidebar UI', async ({ page, request }) => {
	const created = await request
		.post('/api/conversations', { data: { title: 'Rename me' } })
		.then((r) => r.json());

	await page.goto('/');
	const sidebar = page.getByRole('navigation', { name: /Conversations/ });
	const row = sidebar.locator('.conv', { hasText: 'Rename me' });
	await row.getByRole('button', { name: /Actions for Rename me/ }).click();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();

	// Once the menu's Rename is clicked the title text is replaced by an
	// <input>, so locate the input on the sidebar rather than re-filtering
	// the row by its (now-gone) text.
	const input = sidebar.locator('input.rename-input');
	await expect(input).toBeVisible();
	await input.fill('Renamed via UI');
	await input.press('Enter');

	await expect(sidebar.getByText('Renamed via UI')).toBeVisible();

	const get = await request.get(`/api/conversations/${created.conversation.id}`);
	expect((await get.json()).conversation.title).toBe('Renamed via UI');
});
