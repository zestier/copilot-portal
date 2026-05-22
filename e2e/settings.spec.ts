import { test, expect } from '@playwright/test';

// Smoke tests for /settings. Specifically motivated by a regression
// where a Svelte 5 reactivity bug (a `$state` write inside a `$derived`
// computation) made the page throw on hydration. SSR still returned 200
// HTML, so neither svelte-check nor the unit suite caught it. Any spec
// here that loads the page in a browser and asserts an interactive
// element is reachable would have failed loudly.

test('settings page loads with no client-side errors', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
	});

	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Saved permission grants' })).toBeVisible();

	// Open the add-grant <details> and verify the reactive sub-form
	// fields render. <details> doesn't expose an ARIA role consistently,
	// so target the <summary> text directly.
	await page.locator('details.add-grant > summary').click();
	await expect(page.getByRole('combobox', { name: 'Decision' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Tool' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: /argv0/ })).toBeVisible();

	expect(errors, errors.join('\n')).toEqual([]);
});

test('creating a shell+workspace-paths grant adds a row to the list', async ({ page }) => {
	await page.goto('/settings');
	await page.locator('details.add-grant > summary').click();

	// Default tool=shell. Use a unique argv0 so re-runs against the
	// shared DB don't collide (the action dedups identical grants, but
	// using a unique name keeps the post-create assertion unambiguous).
	const argv0 = `e2e${Date.now().toString(36)}`;
	await page.getByLabel(/argv0/).fill(argv0);
	await page.getByLabel(/Positional arguments/).selectOption('workspace-paths');

	await page.getByRole('button', { name: 'Add grant', exact: true }).click();

	// After the form action SvelteKit re-renders the page; the new row
	// should appear with the expected scope description.
	const row = page
		.locator('.grant-list .grant-row')
		.filter({ has: page.locator(`code.pattern:has-text("argv0=${argv0}")`) });
	await expect(row).toBeVisible();
	await expect(row.locator('code.tool')).toHaveText('shell');

	// Revoking via the existing button removes it.
	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(row).toHaveCount(0);
});
