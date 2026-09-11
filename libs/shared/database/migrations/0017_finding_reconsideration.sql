-- Permite registrar el comentario humano que disparó una reconsideración de un
-- hallazgo por parte del LLM, y quién/cuándo la resolvió.
ALTER TABLE findings
  ADD COLUMN resolution_comment text,
  ADD COLUMN resolved_by uuid REFERENCES users (id),
  ADD COLUMN resolved_at timestamptz;
