-- Perfil de proyecto generado automáticamente a partir de CLAUDE.md / AGENTS.md cuando
-- llega un push a un repo que todavía no tiene contexto configurado. NULL = lo
-- configuró una persona; si no es NULL, son los archivos de los que salió (la UI avisa
-- que es un borrador generado y editarlo a mano lo marca como curado).
ALTER TABLE project_profiles ADD COLUMN auto_generated_from text[];
