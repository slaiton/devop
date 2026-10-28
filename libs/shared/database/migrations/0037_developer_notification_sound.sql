-- Sonido de aviso por desarrollador: cuando termina el análisis de un commit suyo, la plataforma suena con
-- el tono que el admin le asignó (lo oye el propio desarrollador en su sesión y el admin, que oye el de todos).
-- NULL = el tono por defecto. El catálogo de tonos vive en la API (notifications/sounds.ts) y los sintetiza el navegador.
ALTER TABLE developers
  ADD COLUMN notification_sound text,
  ADD COLUMN notification_volume numeric(3, 2) NOT NULL DEFAULT 0.8 CHECK (notification_volume BETWEEN 0 AND 1),
  ADD COLUMN notification_muted boolean NOT NULL DEFAULT false;

-- El aviso en vivo busca "análisis terminados desde X" por organización.
CREATE INDEX review_runs_org_completed_idx ON review_runs (organization_id, completed_at) WHERE completed_at IS NOT NULL;
