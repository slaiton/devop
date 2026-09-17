-- Amarre explícito issue↔commit: `first_commit_sha` se fija una sola vez al crear el
-- issue (nunca se pisa en updates posteriores) para no perder qué commit lo originó;
-- `last_commit_sha` refleja el commit del análisis más reciente; `resolved_commit_sha`/
-- `resolved_via` documentan cómo se cerró (por un push que ya no reporta bloqueantes,
-- o por una reconsideración manual — que no trae un commit nuevo asociado).
ALTER TABLE issues ADD COLUMN first_commit_sha text;
ALTER TABLE issues ADD COLUMN last_commit_sha text;
ALTER TABLE issues ADD COLUMN resolved_commit_sha text;
ALTER TABLE issues ADD COLUMN resolved_via text CHECK (resolved_via IN ('push', 'reconsideration'));
