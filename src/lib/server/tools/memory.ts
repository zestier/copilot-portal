import { z } from 'zod';
import * as memory from '../db/repos/memory';
import type { PortalTool } from './git';

const Scope = z.enum(['scene', 'session']);
const Tags = z.array(z.string().trim().min(1).max(100)).max(20).optional();
const Importance = z.number().int().min(1).max(5).optional();
const Kind = z.string().trim().min(1).max(80);
const Entity = z.string().trim().min(1).max(200);
const GUIDANCE = memory.MEMORY_ENTITY_GUIDANCE.join(' ');
const Content = z
	.unknown()
	.refine(memory.isMemoryContent, 'Content must be a JSON-compatible value')
	.refine(memory.isMemoryContentWithinLimit, 'Content is too large');

const WriteArgs = z
	.object({
		scope: Scope,
		kind: Kind,
		entity: Entity.optional(),
		content: Content,
		tags: Tags,
		importance: Importance
	})
	.strict();

const UpdateArgs = z
	.object({
		entity: Entity,
		scope: Scope.optional(),
		kind: Kind.optional(),
		content: Content.optional(),
		tags: Tags,
		importance: Importance
	})
	.strict()
	.refine(
		(args) =>
			args.content !== undefined ||
			args.kind !== undefined ||
			args.tags !== undefined ||
			args.importance !== undefined,
		{ message: 'No fields to update' }
	);

const ForgetArgs = z.object({ entity: Entity, scope: Scope.optional() }).strict();

const QueryArgs = z
	.object({
		q: z.string().trim().max(1000).optional().default(''),
		scope: Scope.optional(),
		includeArchived: z.boolean().optional().default(false),
		limit: z.number().int().min(1).max(50).optional().default(20)
	})
	.strict()
	.optional()
	.default({});

const SceneStartArgs = z
	.object({
		label: z.string().trim().min(1).max(200).optional()
	})
	.strict()
	.optional()
	.default({});

export function buildMemoryTools(opts: { userId: string; conversationId: string }): PortalTool[] {
	return [
		{
			name: 'memory_write',
			description:
				'Record or refine one typed structured memory, addressed by its entity handle. ' +
				'Required kind labels the record (for example character, plot_thread, scene_state, style, bugfix, command); kind is a mutable label, not part of the identity. ' +
				'Use native JSON content. Use scope=scene for short-lived state and scope=session for conversation-wide continuity. ' +
				GUIDANCE,
			argsSchema: WriteArgs,
			parameters: {
				type: 'object',
				properties: {
					scope: {
						type: 'string',
						enum: Scope.options,
						description: 'Persistence level for this memory.'
					},
					kind: {
						type: 'string',
						description:
							'Mutable typed record category, e.g. character, worldbuilding, plot_thread, relationship, scene_state, style, bugfix, command.'
					},
					entity: {
						type: 'string',
						description:
							'Stable dot-path handle that identifies this memory, e.g. story.protagonist.mara, user.memory.style, or repo.commands.validation. Reusing a handle refines that memory in place; give a genuinely distinct fact its own handle (e.g. mara.rel.kael). Omit only when no natural handle exists and one will be generated.'
					},
					content: {
						type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
						description:
							'Native JSON content for the memory. Prefer compact objects or scalar values, not JSON encoded as a string.'
					},
					tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
					importance: {
						type: 'number',
						description: 'Importance from 1 (low) to 5 (high). Defaults to 3.'
					}
				},
				required: ['scope', 'kind', 'content'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = WriteArgs.parse(args);
				const row = memory.write(opts.userId, opts.conversationId, {
					...parsed,
					entity: parsed.entity ?? null,
					source: 'model'
				});
				return `Recorded memory ${row.scope}/${row.entity} [${row.kind}]: ${memory.formatContent(row.content)}`;
			}
		},
		{
			name: 'memory_update',
			description:
				'Update the memory with the given entity handle when a remembered fact changes or can be made more structured, compact, or correct. ' +
				'Addressed by entity (pass scope only to disambiguate a handle used in both a scene and the session). kind may be changed in place. ' +
				'To rename a handle or split a mixed-topic memory, forget the old handle and write the new one(s). ' +
				GUIDANCE,
			argsSchema: UpdateArgs,
			parameters: {
				type: 'object',
				properties: {
					entity: {
						type: 'string',
						description: 'Stable dot-path handle of the memory to update.'
					},
					scope: {
						type: 'string',
						enum: Scope.options,
						description:
							'Optional scope, only needed to disambiguate a handle that exists in both a scene and the session.'
					},
					kind: {
						type: 'string',
						description: 'Replacement mutable typed record category.'
					},
					content: {
						type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
						description: 'Replacement native JSON content.'
					},
					tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
					importance: { type: 'number', description: 'Importance from 1 to 5.' }
				},
				required: ['entity'],
				additionalProperties: false
			},
			async handler(args) {
				const { entity, scope, ...patch } = UpdateArgs.parse(args);
				const row = memory.updateByEntity(opts.userId, opts.conversationId, entity, scope, patch);
				if (!row) throw new Error(`Memory not found: ${entity}`);
				return `Updated memory ${row.scope}/${row.entity} [${row.kind}]: ${memory.formatContent(row.content)}`;
			}
		},
		{
			name: 'memory_forget',
			description:
				'Mark the memory with the given entity handle as forgotten so it no longer appears in the active memory bank. Use when a detail should no longer influence future turns.',
			argsSchema: ForgetArgs,
			parameters: {
				type: 'object',
				properties: {
					entity: {
						type: 'string',
						description: 'Stable dot-path handle of the memory to forget.'
					},
					scope: {
						type: 'string',
						enum: Scope.options,
						description:
							'Optional scope, only needed to disambiguate a handle that exists in both a scene and the session.'
					}
				},
				required: ['entity'],
				additionalProperties: false
			},
			async handler(args) {
				const { entity, scope } = ForgetArgs.parse(args);
				if (!memory.forgetByEntity(opts.userId, opts.conversationId, entity, scope))
					throw new Error(`Memory not found: ${entity}`);
				return `Forgot memory ${entity}`;
			}
		},
		{
			name: 'memory_query',
			description:
				'Search the memory bank for facts not shown in the auto-injected active memory block. Results are addressed by their entity handle. Defaults to active memories only; set includeArchived=true to search past scenes.',
			argsSchema: QueryArgs,
			parameters: {
				type: 'object',
				properties: {
					q: { type: 'string', description: 'Search text. Empty lists recent memories.' },
					scope: { type: 'string', enum: Scope.options, description: 'Optional scope filter.' },
					includeArchived: {
						type: 'boolean',
						description: 'Include archived, forgotten, and superseded memories. Defaults to false.'
					},
					limit: { type: 'number', description: 'Maximum results, 1-50. Defaults to 20.' }
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = QueryArgs.parse(args);
				const rows = parsed.q
					? memory.query(opts.userId, opts.conversationId, parsed.q, parsed)
					: memory.list(opts.userId, opts.conversationId, {
							scope: parsed.scope,
							includeArchived: parsed.includeArchived,
							limit: parsed.limit
						});
				if (rows.length === 0) return '(no memory matches)';
				return rows.map(formatMemoryLine).join('\n');
			}
		},
		{
			name: 'memory_scene_start',
			description:
				'Start a new short-lived scene memory scope. If another scene is open, it is closed first and its active scene memories are archived.',
			argsSchema: SceneStartArgs,
			parameters: {
				type: 'object',
				properties: {
					label: { type: 'string', description: 'Optional scene label.' }
				},
				additionalProperties: false
			},
			async handler(args) {
				const { label } = SceneStartArgs.parse(args);
				const closed = memory.closeScene(opts.userId, opts.conversationId);
				const scene = memory.openScene(opts.userId, opts.conversationId, label);
				const suffix = closed ? ` Closed previous scene ${closed.sceneId}.` : '';
				return `Started memory scene ${scene.id}${scene.label ? ` (${scene.label})` : ''}.${suffix}`;
			}
		},
		{
			name: 'memory_scene_end',
			description:
				'End the current scene and archive its active scene-scoped memories so they stop being auto-injected.',
			argsSchema: z.object({}).strict().optional().default({}),
			parameters: {
				type: 'object',
				properties: {},
				additionalProperties: false
			},
			async handler(args) {
				z.object({}).strict().optional().default({}).parse(args);
				const closed = memory.closeScene(opts.userId, opts.conversationId);
				if (!closed) return 'No memory scene is open.';
				return `Ended memory scene ${closed.sceneId}; archived ${closed.archived} scene memories.`;
			}
		}
	];
}

function formatMemoryLine(row: memory.MemoryRow): string {
	const tags = row.tags.length ? ` ${row.tags.map((tag) => `#${tag}`).join(' ')}` : '';
	return `- ${row.entity} [${row.scope}/${row.status}/${row.kind}] ${memory.formatContent(row.content)}${tags}`;
}
