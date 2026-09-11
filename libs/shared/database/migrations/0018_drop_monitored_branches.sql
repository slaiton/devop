-- Los pushes a analizar ya no se restringen a una lista configurada de ramas: ahora
-- se analiza cualquier push a cualquier rama del repo excepto la rama por defecto
-- (default_branch), sin importar de dónde venga. La columna queda sin uso.
ALTER TABLE repositories DROP COLUMN monitored_branches;
