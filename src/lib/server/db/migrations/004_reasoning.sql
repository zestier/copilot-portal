-- 004_reasoning.sql
-- Persist assistant reasoning (chain-of-thought / thinking) alongside the
-- visible message body so the collapsed "Thought for Xs" affordance
-- survives a page reload. reasoning_duration_ms is best-effort timing
-- captured by the turn runner; both columns are nullable for models that
-- don't expose reasoning.

ALTER TABLE messages ADD COLUMN reasoning TEXT;
ALTER TABLE messages ADD COLUMN reasoning_duration_ms INTEGER;
