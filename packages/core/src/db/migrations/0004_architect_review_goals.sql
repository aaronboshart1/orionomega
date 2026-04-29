-- Architect review goal-verification columns.
-- Adds storage for the requirements list extracted by the architect, the
-- per-requirement verdicts produced by the architect-reviewer, and a
-- counter for how many prior-decision memories were pulled from Hindsight
-- during planning. All three columns are nullable so existing rows
-- continue to load unchanged.

ALTER TABLE architect_reviews ADD COLUMN requirements TEXT;
ALTER TABLE architect_reviews ADD COLUMN goal_verdicts TEXT;
ALTER TABLE architect_reviews ADD COLUMN prior_decisions_count INTEGER;
