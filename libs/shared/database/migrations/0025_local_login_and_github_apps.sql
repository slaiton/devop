-- Login local: el correo/GitHub deja de ser el mecanismo de autenticación — cada
-- usuario tiene su propio hash de contraseña, validado directo contra esta tabla, sin
-- pasar por GitHub OAuth (habrá usuarios sin ninguna relación con las GitHub Apps
-- conectadas, y aun así necesitan poder entrar).
ALTER TABLE users ADD COLUMN password_hash text;

-- Reemplaza la fila singleton de system_settings para GitHub: una organización puede
-- conectar VARIAS GitHub Apps (para sumar repos de distintas cuentas al mismo
-- dashboard), cada una con sus propias credenciales.
CREATE TABLE github_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL,
  github_app_id text NOT NULL,
  slug text NOT NULL,
  client_id text NOT NULL,
  client_secret_encrypted text NOT NULL,
  private_key_encrypted text NOT NULL,
  webhook_secret_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, github_app_id)
);

ALTER TABLE github_apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON github_apps
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Único globalmente (no solo por organización): un App ID de GitHub real no puede
-- pertenecer a dos organizaciones nuestras a la vez, y los webhooks/callbacks
-- entrantes necesitan poder resolver la fila SOLO a partir del App ID, antes de saber
-- el tenant.
CREATE UNIQUE INDEX github_apps_app_id_idx ON github_apps (github_app_id);

-- Cada instalación queda ligada a la App que la generó — antes todas usaban
-- implícitamente la única App global de system_settings. Nullable: instalaciones que
-- ya existieran (de pruebas) quedan sin ligar, no rompe la migración.
ALTER TABLE github_installations ADD COLUMN github_app_id uuid REFERENCES github_apps (id);

-- Resuelve organización + secreto de webhook de una GitHub App a partir de su App ID
-- de GitHub — es la única vía de entrada de un webhook entrante (en una instalación
-- nueva ni siquiera existe todavía github_installations) y sirve tanto para verificar
-- la firma con el secret correcto ANTES de confiar en el payload, como para resolver
-- el tenant. Mismo patrón SECURITY DEFINER que resolve_organization_for_installation
-- (migración 0006), porque github_apps tiene RLS y acá todavía no hay tenant.
CREATE FUNCTION resolve_github_app(p_github_app_id text)
RETURNS TABLE(organization_id uuid, id uuid, webhook_secret_encrypted text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id, id, webhook_secret_encrypted FROM github_apps WHERE github_app_id = p_github_app_id;
$$;

REVOKE ALL ON FUNCTION resolve_github_app(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_github_app(text) TO devsentinel_app;

-- Migra lo que ya hubiera en system_settings (single-app, .env/UI vieja) a una fila
-- github_apps de la primera organización — no perder la configuración ya cargada.
INSERT INTO github_apps
  (organization_id, name, github_app_id, slug, client_id, client_secret_encrypted, private_key_encrypted, webhook_secret_encrypted)
SELECT o.id, 'GitHub App principal', s.github_app_id, s.github_app_slug, s.github_app_client_id,
       s.github_app_client_secret_encrypted, s.github_app_private_key_encrypted, s.github_app_webhook_secret_encrypted
FROM system_settings s, organizations o
WHERE s.id = true
  AND s.github_app_client_id IS NOT NULL
  AND s.github_app_id IS NOT NULL
  AND s.github_app_slug IS NOT NULL
  AND s.github_app_client_secret_encrypted IS NOT NULL
  AND s.github_app_private_key_encrypted IS NOT NULL
  AND s.github_app_webhook_secret_encrypted IS NOT NULL
ORDER BY o.created_at
LIMIT 1;

-- system_settings queda solo para LLM/SMTP; GitHub se gestiona 100% desde github_apps.
ALTER TABLE system_settings
  DROP COLUMN github_app_id,
  DROP COLUMN github_app_slug,
  DROP COLUMN github_app_client_id,
  DROP COLUMN github_app_client_secret_encrypted,
  DROP COLUMN github_app_private_key_encrypted,
  DROP COLUMN github_app_webhook_secret_encrypted;
