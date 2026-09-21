-- Antes, el único criterio para ignorar un push era `branch = repositories.default_branch`
-- (hardcodeado en el webhook handler) — no había forma de agregar otras ramas a
-- ignorar (ej. `develop`, `staging`) sin tocar código. NULL = "todavía no configurado
-- explícitamente", así que el webhook sigue usando `[default_branch]` como antes hasta
-- que un admin lo cambie desde la configuración del repo — no cambia el comportamiento
-- existente para nadie que no toque este campo nuevo.
ALTER TABLE quality_gate_configs ADD COLUMN ignored_push_branches text[];
