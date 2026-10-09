-- Passkeys (WebAuthn) como método principal de acceso, con la contraseña como segunda
-- opción, más el endurecimiento de cuenta que las acompaña. `users` es global (sin RLS):
-- el login ocurre antes de conocer el tenant, así que estas tablas siguen el mismo criterio.

ALTER TABLE users
  -- Identificador estable que se le entrega al autenticador (aleatorio, sin datos
  -- personales — nunca el correo ni el id interno). Se genera al registrar la primera passkey.
  ADD COLUMN webauthn_user_id text UNIQUE,
  -- Se incrusta en el JWT: subirlo invalida todas las sesiones abiertas de ese usuario.
  ADD COLUMN session_version int NOT NULL DEFAULT 0,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN failed_login_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Solo la clave PÚBLICA y metadatos: ninguna huella, imagen ni plantilla biométrica llega
-- jamás al servidor (la verificación biométrica ocurre dentro del autenticador).
CREATE TABLE webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  -- BE/BS del estándar: multiDevice = passkey sincronizable (iCloud, Google, 1Password…);
  -- backup_state indica si ya está respaldada en la nube del proveedor.
  backup_eligible boolean NOT NULL DEFAULT false,
  backup_state boolean NOT NULL DEFAULT false,
  aaguid text,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

-- Challenges de un solo uso (se consumen con DELETE ... RETURNING) con vencimiento corto.
-- En Postgres y no en memoria para que funcione con varias réplicas de la API.
CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'reauth')),
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);

-- Enlaces de un solo uso enviados por correo; se guarda solo el hash del token.
CREATE TABLE account_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens (user_id, purpose);

CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  event text NOT NULL,
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events (user_id, occurred_at DESC);

-- org_memberships tiene RLS; saber si alguien es admin en cualquier organización (para
-- no ofrecerle recuperación de cuenta solo por correo) exige SECURITY DEFINER, igual que
-- resolve_organization_for_user (migración 0012).
CREATE FUNCTION user_has_admin_role(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM org_memberships WHERE user_id = p_user_id AND role = 'admin');
$$;
REVOKE ALL ON FUNCTION user_has_admin_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_has_admin_role(uuid) TO devsentinel_app;

-- La migración 0026 dejó una contraseña genérica de primer acceso para el admin sembrado
-- (está en el repositorio, o sea que es pública): quien siga con esa contraseña debe
-- cambiarla antes de hacer nada más. Se compara con crypt() solo contra hashes bcrypt
-- $2a$/$2y$ (los que genera bcryptjs 2.x), que es lo que pgcrypto sabe leer.
UPDATE users SET must_change_password = true
WHERE password_hash ~ '^\$2[ay]\$'
  AND password_hash = crypt('DevSentinel#2025', password_hash);
