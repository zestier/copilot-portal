-- 010_permission_grants_structured.sql
--
-- Tier 3 of the permissions overhaul: replace string scope_pattern with
-- a structured `scope_json` blob that the matcher can interpret per
-- permission kind (shell argv, fs path containment, url host suffix, ...).
--
-- Legacy rows with NULL scope_json continue to match via the existing
-- substring-glob predicate; new writes only populate scope_json and
-- leave scope_pattern NULL. A later migration can drop scope_pattern
-- once no live rows reference it.

ALTER TABLE permission_grants ADD COLUMN scope_json TEXT;
