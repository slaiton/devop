-- Notificar por correo al autor de cada push analizado, y opcionalmente auto-mergear
-- el PR de promoción cuando el push a la rama origen sale APTO (score verde). El correo
-- sale prendido por defecto para todos los repos (coherente con "para todos los push");
-- el auto-merge arranca apagado — mismo criterio que auto_create_pr_on_push (mergear
-- código sin revisión humana es una acción de más riesgo, mejor opt-in explícito por
-- repo) y de hecho depende de que ese flag también esté activo, ya que reutiliza el
-- mismo PR de promoción source->target.
ALTER TABLE quality_gate_configs
  ADD COLUMN notify_author_on_push boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_merge_on_green boolean NOT NULL DEFAULT false;
