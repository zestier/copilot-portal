type TicketArchiveFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function archiveWorkspaceTicket({
	ticketId,
	workspace,
	fetcher = fetch
}: {
	ticketId: string;
	workspace?: string | null;
	fetcher?: TicketArchiveFetch;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
	const params = new URLSearchParams();
	if (workspace) params.set('workspace', workspace);
	const query = params.toString();
	const res = await fetcher(
		`/api/tickets/${encodeURIComponent(ticketId)}${query ? `?${query}` : ''}`,
		{
			method: 'DELETE'
		}
	);
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true };
}
