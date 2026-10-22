-- Análisis profundo: el revisor puede investigar el repo (leer archivos, buscar usos, ver el
-- historial) antes de dar su veredicto. Se activa por repositorio; 'standard' es la revisión de
-- una sola pasada de siempre, así que ningún repo existente cambia de comportamiento hasta que
-- un admin lo active.
ALTER TABLE quality_gate_configs
  ADD COLUMN analysis_depth text NOT NULL DEFAULT 'standard' CHECK (analysis_depth IN ('standard', 'deep'));

-- Qué pasó realmente en cada revisión: el modo usado (puede ser 'standard' aunque el repo pida
-- 'deep' si el modelo no soporta herramientas o la investigación falló), el motivo de la caída,
-- la traza de consultas que hizo el revisor y el consumo (rondas, tokens, tiempo).
ALTER TABLE review_runs
  ADD COLUMN analysis_mode text CHECK (analysis_mode IN ('standard', 'deep')),
  ADD COLUMN analysis_note text,
  ADD COLUMN analysis_trace jsonb,
  ADD COLUMN analysis_stats jsonb;
