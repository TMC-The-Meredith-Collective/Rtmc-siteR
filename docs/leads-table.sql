-- tmc_solutions_jvs.tmc_solutions.leads — schema of record (applied 2026-10-18)
-- Written ONLY by the lead-intake Worker (worker/tmc-lead-intake-worker.js) through the
-- service principal described in docs/DEPLOY-RUNBOOK.md, Phase 1.
--
-- submitted_at has no column DEFAULT on purpose: the Worker supplies CURRENT_TIMESTAMP()
-- in the INSERT, so the Delta 'allowColumnDefaults' table feature is not needed.
-- Any change to this schema is a migration: get explicit approval before running it.

CREATE TABLE IF NOT EXISTS tmc_solutions_jvs.tmc_solutions.leads (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  submitted_at  TIMESTAMP,
  name          STRING    NOT NULL,
  company       STRING,
  email         STRING    NOT NULL,   -- PII
  phone         STRING,               -- PII (not collected by the current form)
  service       STRING,               -- form "intent" select; Worker allowlists the values
  budget        STRING,               -- not collected by the current form
  message       STRING,
  ip_hash       STRING    NOT NULL,   -- SHA-256 hex of visitor IP; raw IP is never stored
  user_agent    STRING
)
USING DELTA
COMMENT 'Inbound leads from tmcsolutions-org.net contact form'
TBLPROPERTIES (
  'delta.autoOptimize.optimizeWrite' = 'true',
  'delta.autoOptimize.autoCompact'   = 'true'
);
