import type { WorkspaceTicket } from '$lib/types';

export function ticketChatTitle(ticket: Pick<WorkspaceTicket, 'title'>): string {
	return ticket.title;
}

export function ticketChatPrompt(ticket: Pick<WorkspaceTicket, 'id' | 'title' | 'body'>): string {
	const lines = [`Do this workspace ticket: ${ticket.title}`, '', `Ticket ID: ${ticket.id}`];
	const body = ticket.body.trim();
	if (body) lines.push('', body);
	return lines.join('\n');
}
