import type { LayoutServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		conversations: locals.userId ? convs.list(locals.userId, { includeArchived: true }) : []
	};
};
