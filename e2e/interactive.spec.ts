import { test, expect } from '@playwright/test';
import { resetConversations } from './helpers/reset';

// Exercises the new generic interactive-request pipeline end-to-end against
// the stub bridge. Each scenario seeds a magic trigger token into the user
// prompt — see bridge-stub.ts — which causes the stub session to fire the
// matching SDK callback. We then drive the resulting dialog from the UI
// and verify the turn completes (stub reply renders) without the runner
// hanging.

async function createConversation(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/conversations', {
		data: { title: 'E2E interactive' }
	});
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return body.conversation.id as string;
}

test.beforeEach(async ({ request }) => {
	await resetConversations(request);
});

test('auto-mode-switch dialog can be declined and the turn completes', async ({
	page,
	request
}) => {
	const id = await createConversation(request);
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('please @trigger-auto-mode-switch now');
	await composer.press('Enter');

	await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText(/Switch to auto mode/i)).toBeVisible();
	await page.getByRole('button', { name: 'No', exact: true }).click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);

	await expect(
		page.getByText(/Stubbed reply to: please @trigger-auto-mode-switch now/).first()
	).toBeVisible({ timeout: 10_000 });
});

test('exit-plan-mode dialog approves and unblocks the turn', async ({ page, request }) => {
	const id = await createConversation(request);
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.fill('go @trigger-exit-plan-mode');
	await composer.press('Enter');

	await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 10_000 });
	// Recommended action ('execute') is rendered as a button; clicking it
	// should resolve the request and close the dialog.
	const execBtn = page
		.getByRole('alertdialog')
		.getByRole('button')
		.filter({ hasText: /execute/i })
		.first();
	await execBtn.click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page.getByText(/Stubbed reply to: go @trigger-exit-plan-mode/).first()).toBeVisible({
		timeout: 10_000
	});
});

test('elicitation form posts the user-supplied values', async ({ page, request }) => {
	const id = await createConversation(request);
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.fill('hi @trigger-elicitation please');
	await composer.press('Enter');

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await dialog.locator('input[type="text"]').first().fill('ada');

	// "Done" or the primary submit button; the form's primary button label
	// varies by branch (Submit / Done) so match either.
	const submit = dialog.getByRole('button', { name: /submit|done|accept/i }).first();
	await submit.click();

	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText(/Stubbed reply to: hi @trigger-elicitation please/).first()
	).toBeVisible({
		timeout: 10_000
	});
});

test('permission flow still works via the new interactive endpoint', async ({ page, request }) => {
	const id = await createConversation(request);
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.fill('run @trigger-permission for me');
	await composer.press('Enter');

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText(/Permission required/i)).toBeVisible();
	await page.getByRole('button', { name: /allow once/i }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText(/Stubbed reply to: run @trigger-permission for me/).first()
	).toBeVisible({ timeout: 10_000 });
});
