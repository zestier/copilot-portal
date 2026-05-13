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
		const tools = m.toolCalls ?? [];
		const edits = m.fileEdits ?? [];
		const content = m.content ?? '';

		const trailingTools = tools.filter((t) => t.textOffset == null);
		const trailingEdits = edits.filter((e) => e.textOffset == null);
		type Anchor =
			| { offset: number; order: number; kind: 'tool'; tool: (typeof tools)[number] }
			| { offset: number; order: number; kind: 'edit'; edit: (typeof edits)[number] };
		const anchors: Anchor[] = [];
		let order = 0;
		for (const t of tools)
			if (t.textOffset != null)
				anchors.push({
					offset: Math.min(t.textOffset, content.length),
					order: order++,
					kind: 'tool',
					tool: t
				});
		for (const e of edits)
			if (e.textOffset != null)
				anchors.push({
					offset: Math.min(e.textOffset, content.length),
					order: order++,
					kind: 'edit',
					edit: e
				});
		anchors.sort((a, b) => a.offset - b.offset || a.order - b.order);

		const emitTool = (tc: (typeof tools)[number]) => {
			lines.push(`> tool: \`${tc.tool}\` — ${tc.status}`);
			lines.push('```json');
			lines.push(tc.argsJson);
			lines.push('```');
			if (tc.resultJson) {
				lines.push('```json');
				lines.push(tc.resultJson);
				lines.push('```');
			}
		};
		const emitEdit = (fe: (typeof edits)[number]) => {
			lines.push(`> file edit: \`${fe.path}\``);
			lines.push('```diff');
			lines.push(fe.diff);
			lines.push('```');
		};

		let cursor = 0;
		for (const a of anchors) {
			if (a.offset > cursor) {
				lines.push(content.slice(cursor, a.offset));
				cursor = a.offset;
			}
			if (a.kind === 'tool') emitTool(a.tool);
			else emitEdit(a.edit);
		}
		if (cursor < content.length) lines.push(content.slice(cursor));
		else if (cursor === 0) lines.push(content);
		lines.push('');
		for (const tc of trailingTools) emitTool(tc);
		for (const fe of trailingEdits) emitEdit(fe);
	}

	const body = lines.join('\n');
	return new Response(body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="conversation-${conv.id}.md"`
		}
	});
};
