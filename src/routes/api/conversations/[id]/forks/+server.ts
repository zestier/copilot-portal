import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';

/**
 * List forks (child conversations) that were created from this one.
 *
 * Returned items include the source message id, so the client can render
 * a "Forked → …" badge next to the exact message that produced each
 * fork.
 */
export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.userId) throw error(401);
	const source = convs.get(params.id!, locals.userId);
	if (!source) throw error(404);
	const children = convs.listChildren(locals.userId, source.id);
	return json({
		forks: children.map((c) => ({
			id: c.id,
			title: c.title,
			sourceMessageId: c.forkedFromMessageId,
			createdAt: c.createdAt,
			archivedAt: c.archivedAt
		}))
	});
};
