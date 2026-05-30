# Memory-backed stateless sessions

## Summary

This document proposes an optional memory-backed session mode for the portal. In
this mode, every assistant turn is generated from a fresh context assembled from
durable session memory, retrieved history, and explicit memory tools rather than
from a long-running model context window.

The core goal is to make long-running chats more reliable across domains:

- coding sessions that need to remember decisions, failed approaches, and open
  tasks without treating stale memory as current repository truth
- story and role-playing sessions that need stable world state, character
  continuity, and recall of small details
- mystery or investigation sessions that need strict timelines, clue tracking,
  knowledge boundaries, and contradiction checks
- research, planning, and support sessions that need durable decisions,
  evidence, unresolved questions, and provenance

The important design principle is that memory should be explicit, typed,
inspectable, reversible, and scoped. The model remains the language and reasoning
engine; the portal becomes the continuity and state-management layer.

## Non-goals

- Do not replace the existing default chat flow. Memory-backed sessions should be
  opt-in.
- Do not start with cross-session memory. Per-session memory is the safe default.
- Do not treat extracted memories as unquestionable truth. Every durable memory
  needs provenance, status, and correction paths.
- Do not let coding memory override current files or tool results. Repository
  memory is advisory until revalidated.
- Do not hide memory behavior from users. The system must expose what it
  remembered and allow users to correct it.

## High-level architecture

Memory-backed sessions use a fresh model context per request:

```text
user message
  -> classify turn and memory profile
  -> retrieve relevant durable memory
  -> expose memory tools for targeted recall
  -> assemble initial turn packet
  -> model response generation in a fresh context
  -> model may call memory tools during generation
  -> extract candidate memory changes
  -> validate memory patch
  -> commit accepted memory changes transactionally
  -> expose memory diff and validation issues to the user
```

The memory engine is a server-side subsystem with a small API boundary:

```ts
interface MemoryEngine {
  buildInitialPacket(input: BuildInitialPacketInput): Promise<TurnMemoryPacket>;
  listTools(input: ListMemoryToolsInput): Promise<MemoryToolDefinition[]>;
  executeTool(input: ExecuteMemoryToolInput): Promise<MemoryToolResult>;
  extractPatch(input: ExtractMemoryPatchInput): Promise<MemoryPatch>;
  validatePatch(input: ValidateMemoryPatchInput): Promise<MemoryValidationResult>;
  commitPatch(input: CommitMemoryPatchInput): Promise<CommittedMemoryPatch>;
}
```

The chat pipeline should not contain story-, coding-, or mystery-specific logic.
Domain behavior belongs in memory profiles and validators.

## First-pass requirement: memory tools are mandatory

If the portal implements fresh-context sessions, memory tools should be part of
the first implementation rather than a later enhancement.

Fresh-context generation without tools creates a brittle failure mode: the
initial packet must predict everything the model will need. That is especially
weak for older details, user corrections, coding attempts, timeline questions,
and mystery clues. A short packet is useful as a working set, but it cannot be
the only recall mechanism.

The first pass should therefore include a minimal, mandatory memory-tool surface:

| Tool | Purpose |
| --- | --- |
| `memory.search` | Search durable facts, events, decisions, and open loops by text, tags, entities, and time range. |
| `memory.get_entity` | Fetch the canonical state and provenance for one entity. |
| `memory.get_open_loops` | Fetch unresolved tasks, plot threads, clues, questions, or commitments. |
| `memory.get_recent_events` | Fetch recent or relevant event-log entries with source turns. |
| `memory.check_claims` | Validate proposed factual claims against known memory and return conflicts or unknowns. |
| `memory.propose_patch` | Let the model propose structured memory updates when needed, while the server remains responsible for validation and commit. |

These tools should be available to the model during the main response call for
memory-backed sessions. The model should be instructed to call them whenever a
claim depends on prior state that is not present in the initial packet.

Examples of mandatory recall triggers:

- the user asks whether something happened earlier
- the assistant is about to say "you remember", "previously", or "last time"
- an NPC, character, or stakeholder references past knowledge
- an object, file, task, clue, decision, or promise changes state
- a coding response depends on prior commands, prior failures, or earlier design
  decisions
- a story response depends on character location, inventory, relationship, or
  world rules
- a strict session response depends on timeline, alibi, clue, or visibility
  boundaries

The tool layer gives fresh-context sessions a reliable escape hatch: "not in the
packet" means "query memory", not "invent a plausible continuation."

## Memory profiles

Memory profiles define schema, retrieval behavior, validation strictness, and UI
copy. A session has at most one active profile at a time.

### Off

The current chat behavior. No structured memory extraction, no memory tools, and
no memory packet injection.

### Lightweight

General-purpose memory for ordinary chats.

Stores:

- durable decisions
- user-stated preferences scoped to the session
- open loops
- important facts
- compact running summary

Validation is light. The primary goal is usability without much latency.

### Project

Coding- and research-aware memory.

Stores:

- implementation decisions
- prior attempted fixes
- commands run and their historical results
- unresolved bugs or tasks
- relevant files and concepts
- constraints stated by the user
- design tradeoffs

Important rule:

> Project memory may guide where to inspect, but it must not be treated as
> current repository truth unless revalidated against files, tools, or command
> output.

Project memory should distinguish historical observations from current facts.
For example, "tests failed with error X on turn 12" remains useful, but it does
not mean tests still fail.

### Story

Narrative continuity memory.

Stores:

- characters
- locations
- objects
- relationships
- world rules
- narrator style
- scene state
- player-facing knowledge
- unresolved plot threads

Validation catches obvious continuity problems such as duplicated objects,
impossible appearances, forgotten promises, or inconsistent locations.

### Strict

High-integrity continuity mode for mystery, investigation, simulation, or any
session where small details matter.

Stores everything in Story mode plus:

- timeline
- clue ledger
- per-character knowledge
- secrets and visibility boundaries
- alibis
- evidence provenance
- contradiction-sensitive facts

Strict mode prefers correctness over speed. It should call memory tools more
aggressively and may require memory validation before streaming final claims.

### Future: custom

Custom schemas may eventually allow specialized profile definitions. This should
not be part of the first implementation because schema authoring, migration, UI,
and validation complexity are high.

## Data model

Use both event sourcing and materialized state.

The event log records immutable changes and observations. Materialized state
provides fast current lookup.

Suggested tables:

```text
memory_profiles
memory_entities
memory_events
memory_facts
memory_open_loops
memory_decisions
memory_patches
memory_patch_items
memory_validation_issues
memory_tool_calls
```

Potential later tables:

```text
memory_embeddings
memory_entity_links
memory_fact_links
memory_visibility_subjects
```

### `memory_profiles`

Stores the selected mode and profile configuration for a session.

Important fields:

- `session_id`
- `mode`
- `enabled`
- `profile_config_json`
- `created_at`
- `updated_at`

### `memory_entities`

Stores addressable entities.

Examples:

- `character.elias`
- `object.silver_key`
- `file.src_routes_chat`
- `decision.auth_storage`
- `topic.memory_engine`

Important fields:

- `id`
- `session_id`
- `entity_key`
- `entity_type`
- `display_name`
- `summary`
- `status`
- `metadata_json`
- `created_at`
- `updated_at`

### `memory_events`

Immutable event log.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `event_type`
- `occurred_at`
- `actor_entity_id`
- `target_entity_id`
- `summary`
- `payload_json`
- `visibility`
- `confidence`
- `source_message_id`
- `source_tool_call_id`
- `created_at`

Events should not be edited in place. Corrections should append compensating
events or supersede derived facts.

### `memory_facts`

Current and historical facts.

Important fields:

- `id`
- `session_id`
- `entity_id`
- `predicate`
- `value_json`
- `status`
- `visibility`
- `confidence`
- `source_event_id`
- `supersedes_fact_id`
- `created_at`
- `updated_at`

Status values:

- `active`
- `superseded`
- `disputed`
- `deleted`

### `memory_open_loops`

Unresolved tasks, promises, mysteries, story threads, research questions, and
follow-ups.

Important fields:

- `id`
- `session_id`
- `loop_type`
- `title`
- `description`
- `status`
- `priority`
- `related_entity_ids_json`
- `source_event_id`
- `created_at`
- `updated_at`

### `memory_decisions`

Durable decisions made during the session.

Important fields:

- `id`
- `session_id`
- `subject`
- `decision`
- `rationale`
- `status`
- `source_event_id`
- `created_at`
- `updated_at`

### `memory_patches`

Every post-turn extraction should create a patch record, even if no changes are
committed.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `status`
- `summary`
- `raw_patch_json`
- `validation_result_json`
- `created_at`
- `committed_at`

Status values:

- `draft`
- `committed`
- `partially_committed`
- `rejected`
- `needs_review`
- `reverted`

### `memory_tool_calls`

Audit trail for model memory-tool usage.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `tool_name`
- `arguments_json`
- `result_summary`
- `result_ids_json`
- `created_at`

This is useful for debugging why the model remembered or asserted something.

## Memory primitives

The common model should support these primitives across profiles:

| Primitive | Meaning |
| --- | --- |
| Entity | Person, file, object, location, feature, bug, clue, concept, decision, task. |
| Event | Something that happened or was observed. |
| Fact | A durable assertion about an entity. |
| Decision | A choice made by user, assistant, or team. |
| Observation | A fact-like note that may become stale. |
| Open loop | Unresolved task, promise, question, clue, or plot thread. |
| Source | Provenance back to a message, turn, event, or tool call. |
| Visibility | Who is allowed to know or receive the fact. |
| Confidence | Extractor certainty. |
| Status | Whether the item is active, superseded, disputed, deleted, or needs review. |

## Retrieval and packet assembly

The memory engine should build an initial turn packet before the main model call.
This packet is not expected to contain everything; it is a compact working set
plus instructions for tool-based recall.

Example:

```json
{
  "memory_mode": "project",
  "session_summary": "The user is designing memory-backed stateless sessions.",
  "relevant_decisions": [
    {
      "id": "decision_12",
      "subject": "fresh_context",
      "decision": "Use a fresh context window per request.",
      "source_turn_id": "turn_8"
    }
  ],
  "open_loops": [
    {
      "id": "loop_5",
      "title": "Define first-pass memory tools",
      "status": "active"
    }
  ],
  "relevant_facts": [],
  "recent_events": [],
  "tool_guidance": {
    "must_query_when_missing_prior_state": true,
    "available_tools": [
      "memory.search",
      "memory.get_entity",
      "memory.get_open_loops",
      "memory.get_recent_events",
      "memory.check_claims",
      "memory.propose_patch"
    ]
  }
}
```

Retrieval should combine:

- symbolic entity lookup
- profile-specific query expansion
- recency
- open-loop priority
- text search
- eventual vector search
- explicit visibility constraints

## Tool behavior

### `memory.search`

Search durable memory by text, type, entity, tag, source, visibility, and time
range.

Inputs:

- `query`
- `types`
- `entity_ids`
- `status`
- `visibility`
- `limit`

Output:

- compact result objects
- source IDs
- confidence
- visibility
- "more results available" flag

### `memory.get_entity`

Fetch canonical state for one entity.

Output should include:

- entity metadata
- active facts
- recent events
- open loops
- provenance
- status

### `memory.get_open_loops`

Fetch unresolved loops relevant to the current turn.

Supports filters:

- `loop_type`
- `entity_ids`
- `priority`
- `visibility`

### `memory.get_recent_events`

Fetch recent or entity-specific events.

Useful for continuity and conversational flow.

### `memory.check_claims`

Validate proposed claims before they are stated or committed.

Input:

```json
{
  "claims": [
    {
      "subject": "object.silver_key",
      "predicate": "location",
      "value": "study_desk"
    }
  ]
}
```

Output:

- `supported`
- `contradicted`
- `unknown`
- relevant source facts/events

### `memory.propose_patch`

Accepts a structured memory patch proposal from the model. The server validates
and commits it; the model never writes directly to canonical memory.

## Extraction and commit flow

After a response, the extractor creates a memory patch:

```json
{
  "events": [],
  "facts_to_add": [],
  "facts_to_supersede": [],
  "decisions_to_add": [],
  "open_loops_to_add": [],
  "open_loops_to_resolve": [],
  "uncertain_items": []
}
```

The validator checks the patch. The committer writes accepted changes in a
transaction. Rejected or uncertain changes remain visible as validation issues.

Commit rules:

- every committed item must have source provenance
- no direct mutation of immutable events
- fact changes supersede prior facts rather than deleting them
- low-confidence items are either discarded or marked `needs_review`
- strict-mode conflicts block commit unless explicitly resolved

## Validation

Validation must be profile-specific.

### General validation

- missing provenance
- duplicate facts
- invalid entity references
- conflicting active facts
- stale observations
- low-confidence extraction
- visibility leakage

### Project validation

- file facts must be marked historical unless verified this turn
- test results must be historical
- tool output should not be persisted wholesale
- secrets should not be stored
- prior attempts should include outcome and source

### Story validation

- inconsistent entity locations
- impossible object duplication
- dead or unavailable characters appearing without explanation
- unresolved promises being contradicted
- player knowledge mismatches

### Strict validation

- timeline contradictions
- impossible travel or action ordering
- clue availability mismatches
- alibi conflicts
- secret leakage
- NPC knowledge impossible from observed events
- claims unsupported by player-facing evidence

## User interface

### Session setting

Expose a memory selector in session settings:

```text
Memory mode: Off / Lightweight / Project / Story / Strict
```

Suggested copy:

- **Off**: "Use only the current conversation context."
- **Lightweight**: "Remember decisions, preferences, facts, and open loops for
  this session."
- **Project**: "Track implementation context, prior attempts, and decisions.
  Repository claims are rechecked before use."
- **Story**: "Track characters, locations, objects, relationships, and plot
  continuity."
- **Strict**: "Use detailed memory tools and validation for timelines, clues,
  secrets, and fine-grained continuity."

### Memory inspector

The inspector is required for trust and debugging.

Tabs:

- Facts
- Events
- Entities
- Decisions
- Open loops
- Tool calls
- Validation issues
- Patches

Actions:

- edit supported mutable records
- mark wrong
- delete or hide
- pin
- revert patch
- wipe session memory
- export memory

### Memory diff

After each turn in memory-backed mode, show a collapsed memory update summary:

```text
Memory updated: 2 facts, 1 decision, 1 open loop
```

Expanded view:

```diff
+ Decision: Fresh-context sessions should include memory tools in the first pass.
+ Open loop: Define memory tool schemas.
~ Fact: Memory mode MVP scope updated.
```

### Responsiveness indicators

Use small, honest status labels:

- "Checking memory..."
- "Searching prior session state..."
- "Validating memory changes..."
- "Memory update needs review"

Avoid blocking the user on post-turn extraction except in strict mode when a
conflict would make the answer unreliable.

## Responsiveness and performance

Memory mode should not make ordinary chat feel slow.

### Fast path

For Lightweight and Project modes:

```text
pre-turn structured lookup
  -> initial packet
  -> stream response
  -> async extraction and validation
```

The model still has memory tools during generation. The initial lookup should be
cheap, and tool calls should be targeted.

### Strict path

For Strict mode:

```text
pre-turn retrieval
  -> mandatory validation of relevant constraints
  -> model response with memory tools
  -> post-turn extraction
  -> validation
  -> commit or review
```

Strict mode may add latency. That is acceptable if clearly communicated.

### Latency targets

Approximate added pre-stream latency, excluding model calls:

| Mode | Target |
| --- | --- |
| Lightweight | 100-250ms |
| Project | 250-500ms |
| Story | 250-750ms |
| Strict | correctness over speed |

### Caching

Useful caches:

- last turn packet
- recent open loops
- active facts by entity
- profile configuration
- recent memory search results within a turn

Do not cache across visibility or session boundaries.

## Storage and retrieval technologies

Start with SQLite.

Recommended first implementation:

- normalized tables for entities, facts, events, decisions, open loops, patches
- JSON columns for profile-specific payloads
- SQLite FTS for lexical search
- indexes on `session_id`, `entity_id`, `status`, `visibility`, `created_at`,
  and `updated_at`

Defer embeddings until there is enough real memory data to evaluate retrieval
quality.

Later options:

- `sqlite-vec` or similar local vector extension
- provider embeddings with local cache
- hybrid symbolic + lexical + vector retrieval

Avoid starting with an external vector database unless deployment requirements
change. It adds operational and privacy complexity before the product value is
proven.

## Security, privacy, and isolation

Defaults:

- memory is per-session
- memory is off unless the user enables it or a profile explicitly creates a new
  memory-backed session
- cross-session memory is opt-in
- deleted sessions delete associated memory
- exported sessions include memory data
- users can wipe memory without deleting the chat
- memory respects existing auth boundaries

Sensitive data rules:

- do not persist secrets from files, command output, environment variables, or
  tool responses
- avoid storing raw tool output unless explicitly needed
- store compact summaries with source links instead
- mark permission-related facts narrowly; do not silently broaden them into
  future grants or preferences

## Migration and rollout

### Phase 0: design spike

- define database schema
- define memory engine interface
- define memory tool schemas
- identify chat pipeline integration points
- create UI mock for memory mode selector and inspector
- create transcript fixtures for extraction tests

### Phase 1: lightweight memory with mandatory tools

First production-capable slice:

- per-session memory mode: Off / Lightweight
- fresh-context request path for memory-backed sessions
- initial memory packet assembly
- mandatory memory tools:
  - `memory.search`
  - `memory.get_entity`
  - `memory.get_open_loops`
  - `memory.get_recent_events`
  - `memory.check_claims`
  - `memory.propose_patch`
- post-turn extraction
- patch validation
- transactional commit
- read-only inspector
- session memory wipe
- memory diff summary after turns

### Phase 2: project profile

- coding-aware schemas
- historical command/test records
- implementation decisions
- unresolved bugs/tasks
- stale repository fact handling
- stronger secret filtering

### Phase 3: story profile

- character/location/object schemas
- scene packet assembly
- world rules
- style memory
- continuity validation

### Phase 4: strict profile

- timeline
- clue ledger
- per-character knowledge
- visibility solver
- strict contradiction checking
- review-required memory patches

### Phase 5: advanced retrieval

- SQLite FTS tuning
- optional embeddings
- retrieval scoring
- packet budget optimization
- evaluation suite for recall quality

### Phase 6: cross-session memory

Only after per-session memory is reliable.

- explicit opt-in
- project-scoped memory
- user-scoped preferences
- namespace controls
- global memory inspector

## Testing strategy

### Unit tests

- packet assembly
- tool argument validation
- memory search filters
- entity lookup
- fact supersession
- patch validation
- commit transactions
- wipe/delete behavior
- profile-specific validators

### Golden transcript tests

For each profile, maintain fixtures:

```text
transcript input
  -> expected memory patch
  -> expected packet on next turn
  -> expected tool result for targeted recall
```

Important cases:

- user corrects assistant memory
- old detail recalled via tool
- low-confidence extraction rejected
- open loop resolved
- coding test result becomes stale
- story object moves location
- strict-mode secret does not leak

### Integration tests

- memory-backed session streams a response
- memory tool calls are audited
- post-turn extraction commits patch
- inspector displays committed memory
- wipe removes session memory
- validation issue appears when conflict is detected

### Performance tests

Measure:

- packet build time
- tool call query time
- extraction time
- validation time
- end-to-first-token latency
- DB growth over long sessions

## Open design questions

- Should memory extraction use the same model as the chat response, a smaller
  model, or deterministic rules where possible?
- Should Strict mode block final streaming until `memory.check_claims` passes for
  important claims?
- How should the portal distinguish "assistant invented this" from "assistant
  established this as canon" in creative sessions?
- How should user edits to memory be represented: direct mutation, correction
  events, or both?
- What is the right default profile for a new coding chat, if any?
- Should memory tools be visible in the transcript, hidden, or shown in a
  developer/debug drawer?
- How much raw transcript should be kept in the initial packet for tone and
  conversational momentum?

## Recommended MVP cutline

The smallest version worth building:

1. Off and Lightweight modes.
2. Fresh-context path for memory-backed sessions.
3. Mandatory first-pass memory tools.
4. SQLite tables for entities, events, facts, decisions, open loops, patches,
   validation issues, and tool-call audits.
5. Initial packet assembly.
6. Post-turn extraction and transactional commit.
7. Read-only memory inspector.
8. Memory diff after turns.
9. Session memory wipe.
10. Golden tests for recall, correction, and patch validation.

The MVP should not include custom schemas, embeddings, cross-session memory, or a
full strict mystery validator. Those should follow after the core loop is stable.

## Success criteria

The feature is working when:

- a memory-backed session can answer questions about prior details by using
  memory tools rather than relying on hidden context
- users can inspect what was remembered and where it came from
- users can wipe or correct bad memory
- coding memories are treated as historical unless revalidated
- long story sessions preserve object, character, and world-state continuity
- strict sessions can detect at least basic contradictions before committing
  memory
- ordinary chats remain fast when memory is off

