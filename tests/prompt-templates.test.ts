import { describe, expect, it, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

function event(opts: {
	url?: string;
	userId: string | null;
	body?: unknown;
	params?: Record<string, string>;
}) {
	return {
		locals: { userId: opts.userId },
		params: opts.params ?? {},
		url: new URL(opts.url ?? 'http://localhost/api/prompt-templates'),
		request: new Request(opts.url ?? 'http://localhost/api/prompt-templates', {
			method: opts.body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		})
	};
}

describe('prompt templates', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-prompt-templates-');
	});

	it('repo scopes custom templates by user and archives instead of deleting', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const promptTemplates = await import('../src/lib/server/db/repos/prompt-templates');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'prompt-rival',
			githubId: 909,
			displayName: null,
			avatarUrl: null
		});

		const template = promptTemplates.create(user.id, {
			title: 'Release checklist',
			description: 'Verify release readiness',
			prompt: 'Check changelog, tests, and deployment steps.',
			pinned: true,
			orderIndex: 5
		});
		promptTemplates.create(other.id, {
			title: 'Other user',
			prompt: 'Do not show this.'
		});

		expect(promptTemplates.list(user.id).map((item) => item.id)).toEqual([template.id]);
		expect(promptTemplates.get(template.id, other.id)).toBeNull();
		expect(() => promptTemplates.create(user.id, { title: '   ', prompt: 'x' })).toThrow(
			'prompt template title cannot be empty'
		);
		expect(() => promptTemplates.create(user.id, { title: 'x', prompt: '   ' })).toThrow(
			'prompt template body cannot be empty'
		);

		const archived = promptTemplates.archive(template.id, user.id);
		expect(archived?.status).toBe('archived');
		expect(archived?.archivedAt).toBeTypeOf('number');
		expect(promptTemplates.list(user.id)).toEqual([]);
		expect(promptTemplates.list(user.id, { status: 'all' }).map((item) => item.id)).toEqual([
			template.id
		]);
	});

	it('API lists built-ins and performs user-scoped custom CRUD', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const { GET, POST } = await import('../src/routes/api/prompt-templates/+server');
		const { PATCH, DELETE } = await import('../src/routes/api/prompt-templates/[id]/+server');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'prompt-api-rival',
			githubId: 910,
			displayName: null,
			avatarUrl: null
		});

		const builtInsResponse = await GET(event({ userId: user.id }) as never);
		const builtIns = await builtInsResponse.json();
		expect(builtIns.builtInTemplates.length).toBeGreaterThan(0);
		expect(builtIns.customTemplates).toEqual([]);

		const createResponse = await POST(
			event({
				userId: user.id,
				body: {
					title: 'Investigate flaky test',
					description: 'Find a reliable repro',
					prompt: 'Run the relevant tests and isolate the flaky condition.',
					pinned: true,
					orderIndex: 2
				}
			}) as never
		);
		expect(createResponse.status).toBe(201);
		const created = await createResponse.json();
		expect(created.template).toMatchObject({
			title: 'Investigate flaky test',
			source: 'custom',
			pinned: true
		});

		const listResponse = await GET(event({ userId: user.id }) as never);
		const listed = await listResponse.json();
		expect(listed.customTemplates.map((item: { id: string }) => item.id)).toEqual([
			created.template.id
		]);

		const deniedPatch = PATCH(
			event({
				userId: other.id,
				params: { id: created.template.id },
				body: { title: 'Nope' }
			}) as never
		);
		await expect(deniedPatch).rejects.toMatchObject({ status: 404 });

		const patchResponse = await PATCH(
			event({
				userId: user.id,
				params: { id: created.template.id },
				body: {
					title: 'Investigate flaky test quickly',
					prompt: 'Reproduce the flaky test and summarize the fix.',
					pinned: false
				}
			}) as never
		);
		const patched = await patchResponse.json();
		expect(patched.template).toMatchObject({
			title: 'Investigate flaky test quickly',
			pinned: false
		});

		const deleteResponse = await DELETE(
			event({ userId: user.id, params: { id: created.template.id } }) as never
		);
		const archived = await deleteResponse.json();
		expect(archived.template.status).toBe('archived');
	});

	it('conversation load prefills the composer from built-in and custom templates only for the owner', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const promptTemplates = await import('../src/lib/server/db/repos/prompt-templates');
		const { load } = await import('../src/routes/conversations/[id]/+page.server');
		const user = users.ensureLocalUser();
		const other = users.upsertGithub({
			githubLogin: 'prompt-load-rival',
			githubId: 911,
			displayName: null,
			avatarUrl: null
		});
		const conv = convs.create(user.id, { title: 'Prompt draft', workdir: '/tmp', model: null });
		const custom = promptTemplates.create(user.id, {
			title: 'Custom launch',
			prompt: 'Start from my saved prompt.'
		});

		const customData = await load({
			params: { id: conv.id },
			locals: { userId: user.id },
			url: new URL(
				`http://localhost/conversations/${conv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`
			)
		} as never);
		expect((customData as { initialComposer: string }).initialComposer).toBe(
			'Start from my saved prompt.'
		);

		const builtInData = await load({
			params: { id: conv.id },
			locals: { userId: user.id },
			url: new URL(
				`http://localhost/conversations/${conv.id}?promptTemplateSource=builtin&promptTemplateId=debug-error`
			)
		} as never);
		expect((builtInData as { initialComposer: string }).initialComposer).toContain(
			'debugging an error'
		);

		promptTemplates.archive(custom.id, user.id);
		await expect(
			load({
				params: { id: conv.id },
				locals: { userId: user.id },
				url: new URL(
					`http://localhost/conversations/${conv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`
				)
			} as never)
		).rejects.toMatchObject({ status: 404 });

		const otherConv = convs.create(other.id, {
			title: 'Other prompt draft',
			workdir: '/tmp',
			model: null
		});
		await expect(
			load({
				params: { id: otherConv.id },
				locals: { userId: other.id },
				url: new URL(
					`http://localhost/conversations/${otherConv.id}?promptTemplateSource=custom&promptTemplateId=${custom.id}`
				)
			} as never)
		).rejects.toMatchObject({ status: 404 });
	});
});
