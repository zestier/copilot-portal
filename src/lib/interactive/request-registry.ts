import type { InteractiveKind, InteractiveRequestView, InteractiveResponse } from '$lib/types';

const interactiveKindDescriptors = {
	permission: () => ({ kind: 'permission', decision: 'deny' }),
	auto_mode_switch: () => ({ kind: 'auto_mode_switch', decision: 'no' }),
	user_input: () => ({ kind: 'user_input', answer: '', wasFreeform: true }),
	elicitation: () => ({ kind: 'elicitation', action: 'cancel' }),
	exit_plan_mode: () => ({ kind: 'exit_plan_mode', approved: false }),
	sampling: () => ({ kind: 'sampling', action: 'ack' }),
	mcp_oauth: () => ({ kind: 'mcp_oauth', action: 'ack' }),
	external_tool: () => ({ kind: 'external_tool', action: 'ack' })
} satisfies {
	[K in InteractiveKind]: () => Extract<InteractiveResponse, { kind: K }>;
};

export function defaultInteractiveResponse(kind: InteractiveKind): InteractiveResponse {
	return interactiveKindDescriptors[kind]();
}

export type InformationalInteractiveKind = 'sampling' | 'mcp_oauth' | 'external_tool';
export type InformationalInteractiveRequest = Extract<
	InteractiveRequestView,
	{ kind: InformationalInteractiveKind }
>;

interface InformationalRequestDescriptor<K extends InformationalInteractiveKind> {
	heading(request: Extract<InformationalInteractiveRequest, { kind: K }>): string;
	actionLabel: string;
	response(): Extract<InteractiveResponse, { kind: K }>;
}

const informationalRequestDescriptors = {
	sampling: {
		heading: (request) => {
			void request;
			return 'MCP sampling request';
		},
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'sampling', action: 'ack' })
	},
	mcp_oauth: {
		heading: (request) => {
			void request;
			return 'MCP server authentication';
		},
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'mcp_oauth', action: 'ack' })
	},
	external_tool: {
		heading: (request) => `External tool: ${request.toolName}`,
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'external_tool', action: 'ack' })
	}
} satisfies {
	[K in InformationalInteractiveKind]: InformationalRequestDescriptor<K>;
};

export function isInformationalInteractiveRequest(
	request: InteractiveRequestView
): request is InformationalInteractiveRequest {
	return (
		request.kind === 'sampling' || request.kind === 'mcp_oauth' || request.kind === 'external_tool'
	);
}

export function informationalHeading(request: InformationalInteractiveRequest): string {
	switch (request.kind) {
		case 'sampling':
			return informationalRequestDescriptors.sampling.heading(request);
		case 'mcp_oauth':
			return informationalRequestDescriptors.mcp_oauth.heading(request);
		case 'external_tool':
			return informationalRequestDescriptors.external_tool.heading(request);
	}
}

export function informationalActionLabel(request: InformationalInteractiveRequest): string {
	return informationalRequestDescriptors[request.kind].actionLabel;
}

export function informationalResponse(
	request: InformationalInteractiveRequest
): Extract<InteractiveResponse, { kind: InformationalInteractiveKind }> {
	switch (request.kind) {
		case 'sampling':
			return informationalRequestDescriptors.sampling.response();
		case 'mcp_oauth':
			return informationalRequestDescriptors.mcp_oauth.response();
		case 'external_tool':
			return informationalRequestDescriptors.external_tool.response();
	}
}
