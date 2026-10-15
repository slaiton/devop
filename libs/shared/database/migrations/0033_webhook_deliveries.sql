-- Registro de CADA petición que llega al receptor de webhooks de GitHub, aceptada o no.
-- Hasta ahora lo único que quedaba era una línea en el log del contenedor: si una GitHub App
-- no "recibía nada", no había forma de saber si GitHub no enviaba, si llegaba y se rechazaba
-- (App ID o secret mal guardados) o si llegaba y se descartaba a propósito (rama en la
-- lista de omitidas, push duplicado…).
--
-- Sin RLS a propósito: un webhook rechazado (App ID desconocido) no pertenece a ningún tenant
-- todavía. Quien lo lea debe filtrar por organization_id (o IS NULL) — lo hace el servicio.
-- No se guarda el payload: solo cabeceras y, únicamente cuando la firma fue válida, un
-- resumen (repo, rama, commit). Lo que llega con firma inválida no es de fiar y no se vuelca.
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  delivery_guid text,
  event text,
  action text,
  -- Tal cual vino en X-GitHub-Hook-Installation-Target-ID (sirve para ver qué App ID llega
  -- aunque no coincida con ninguna registrada).
  github_app_id text,
  github_app_row_id uuid REFERENCES github_apps (id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('processed', 'ignored', 'rejected', 'error')),
  reason text NOT NULL,
  detail text,
  repository text,
  ref text,
  commit_sha text,
  review_run_id uuid REFERENCES review_runs (id) ON DELETE SET NULL,
  status_code int NOT NULL,
  duration_ms int,
  source_ip text,
  user_agent text,
  content_type text,
  payload_bytes int
);

CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries (received_at DESC);
CREATE INDEX webhook_deliveries_org_idx ON webhook_deliveries (organization_id, received_at DESC);
CREATE INDEX webhook_deliveries_app_idx ON webhook_deliveries (github_app_row_id, received_at DESC);
