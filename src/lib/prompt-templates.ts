import type { ChatPromptTemplate } from './types';

export type PromptTemplateSource = 'builtin' | 'custom';

export type PromptTemplateListItem = ChatPromptTemplate & {
	source: PromptTemplateSource;
};

export const BUILT_IN_PROMPT_TEMPLATES: ChatPromptTemplate[] = [
	{
		id: 'code-review',
		userId: null,
		title: 'Code review',
		description: 'Review changed code for bugs, regressions, and security issues.',
		prompt:
			'Review the current code changes for correctness, security, and maintainability. Focus on issues that matter and suggest concrete fixes.',
		status: 'open',
		pinned: true,
		orderIndex: 10,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'debug-error',
		userId: null,
		title: 'Debug an error',
		description: 'Investigate a failing command, stack trace, or unexpected behavior.',
		prompt:
			'I need help debugging an error. Start by asking for or inspecting the failing command/output, identify likely root causes, and propose the smallest safe fix.',
		status: 'open',
		pinned: true,
		orderIndex: 20,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'plan-implementation',
		userId: null,
		title: 'Plan implementation',
		description: 'Create a focused implementation plan before changing code.',
		prompt:
			'Help plan this implementation. Inspect the relevant code paths, call out risks or open questions, and propose a concise step-by-step approach before editing.',
		status: 'open',
		pinned: false,
		orderIndex: 30,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'explain-code',
		userId: null,
		title: 'Explain code',
		description: 'Explain how a feature, file, or flow works in this repository.',
		prompt:
			'Explain how this part of the codebase works. Trace the important files and data flow, and summarize the behavior, extension points, and gotchas.',
		status: 'open',
		pinned: false,
		orderIndex: 40,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	}
];

export function listBuiltInPromptTemplates(): PromptTemplateListItem[] {
	return BUILT_IN_PROMPT_TEMPLATES.map((template) => ({ ...template, source: 'builtin' }));
}

export function getBuiltInPromptTemplate(id: string): ChatPromptTemplate | null {
	return BUILT_IN_PROMPT_TEMPLATES.find((template) => template.id === id) ?? null;
}
