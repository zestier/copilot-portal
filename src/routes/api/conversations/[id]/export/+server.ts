import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';

// GET /api/conversations/:id/export — emits a single markdown file
// summarizing the conversation.
export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id!, locals.userId);
	if (!conv) throw error(404);
	const msgs = messages.listByConversation(conv.id);

	const lines: string[] = [];
	lines.push(`# ${conv.title}`);
	lines.push('');
	lines.push(`- Created: ${new Date(conv.createdAt).toISOString()}`);
	lines.push(`- Workdir: \`${conv.workdir}\``);
	if (conv.model) lines.push(`- Model: ${conv.model}`);
	lines.push('');

	for (const m of msgs) {
		lines.push(`---`);
		lines.push(`## ${m.role} — ${new Date(m.createdAt).toISOString()}`);
		lines.push('');
		lines.push(m.content);
		lines.push('');
		for (const tc of m.toolCalls ?? []) {
			lines.push(`> tool: \`${tc.tool}\` — ${tc.status}`);
			lines.push('```json');
			lines.push(tc.argsJson);
			lines.push('```');
			if (tc.resultJson) {
				lines.push('```json');
				lines.push(tc.resultJson);
				lines.push('```');
			}
		}
		for (const fe of m.fileEdits ?? []) {
			lines.push(`> file edit: \`${fe.path}\``);
			lines.push('```diff');
			lines.push(fe.diff);
			lines.push('```');
		}
	}

	const body = lines.join('\n');
	return new Response(body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="conversation-${conv.id}.md"`
		}
	});
};
