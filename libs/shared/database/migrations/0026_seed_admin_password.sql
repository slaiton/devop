-- Desde la migración 0025 el login ya no pasa por GitHub OAuth, sino por
-- correo+contraseña contra `users.password_hash` (ver AuthService.login). El admin
-- sembrado en 0023 quedó sin contraseña — sin esto, nadie puede entrar a este
-- despliegue todavía. Esta migración:
--   1. Re-asegura la organización/usuario/membresía de 0023 (idempotente, por si esta
--      migración corre en un despliegue donde 0023 no llegó a aplicarse).
--   2. Setea una contraseña GENÉRICA de primer inicio de sesión, SOLO si el usuario
--      todavía no tiene ninguna (`password_hash IS NULL`) — nunca pisa una contraseña
--      que el admin ya haya cambiado.
--
-- Contraseña temporal: DevSentinel#2025
-- Cámbiala apenas inicies sesión, desde "Mi perfil" → "Cambiar mi contraseña".
--
-- pgcrypto da `crypt()`/`gen_salt('bf')`, que generan un hash bcrypt ($2a$) idéntico en
-- formato al que produce bcryptjs en Node — se pueden verificar indistintamente.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO organizations (name, slug)
SELECT 'slaiton', 'slaiton'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'slaiton');

INSERT INTO users (github_user_id, email, name)
SELECT NULL, 'jhoan.laiton@aldialogistica.com', 'Jhoan Laiton'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE lower(email) = lower('jhoan.laiton@aldialogistica.com')
);

INSERT INTO org_memberships (organization_id, user_id, role)
SELECT o.id, u.id, 'admin'
FROM organizations o, users u
WHERE o.slug = 'slaiton'
  AND lower(u.email) = lower('jhoan.laiton@aldialogistica.com')
  AND NOT EXISTS (
    SELECT 1 FROM org_memberships m WHERE m.organization_id = o.id AND m.user_id = u.id
  );

UPDATE users
SET password_hash = crypt('DevSentinel#2025', gen_salt('bf', 12))
WHERE lower(email) = lower('jhoan.laiton@aldialogistica.com')
  AND password_hash IS NULL;
