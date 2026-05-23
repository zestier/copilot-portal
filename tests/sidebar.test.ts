import { describe, it, expect } from 'vitest';
import { resolveInitialSidebarOpen } from '../src/lib/client/sidebar';
import { ticketChatPrompt, ticketChatTitle } from '../src/lib/client/tickets';

describe('resolveInitialSidebarOpen', () => {
	it('honors a persisted "true" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'true', isDesktop: () => false })).toBe(
			true
		);
	});

	it('honors a persisted "false" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'false', isDesktop: () => true })).toBe(
			false
		);
	});

	it('defaults to open on desktop when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => true })).toBe(true);
	});

	it('defaults to closed on mobile when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => false })).toBe(
			false
		);
	});

	it('treats unrecognized stored values as missing', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'garbage', isDesktop: () => false })).toBe(
			false
		);
		expect(resolveInitialSidebarOpen({ getStored: () => '', isDesktop: () => true })).toBe(true);
	});
});

describe('ticket chat helpers', () => {
	it('uses the ticket title as the chat title', () => {
		expect(ticketChatTitle({ title: 'Fix sidebar actions' })).toBe('Fix sidebar actions');
	});

	it('builds an actionable initial prompt for a ticket with details', () => {
		expect(
			ticketChatPrompt({
				id: 'ticket-1',
				title: 'Fix sidebar actions',
				body: 'Add a launch button.'
			})
		).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1\n\nAdd a launch button.'
		);
	});

	it('omits empty ticket details from the initial prompt', () => {
		expect(ticketChatPrompt({ id: 'ticket-1', title: 'Fix sidebar actions', body: '  ' })).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1'
		);
	});
});
