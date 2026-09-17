-- Semilla de la organización y el primer admin de este despliegue, para no depender de
-- completar a mano el formulario de /setup. El slug DEBE coincidir exactamente con la
-- cuenta de GitHub donde se instalará la GitHub App (github.com/slaiton) — si no
-- coincide, esa instalación crea una organización duplicada (ver
-- UsersService.bootstrapFirstAdmin, mismo criterio). Idempotente a propósito: usa
-- `WHERE NOT EXISTS` en vez de asumir que corre una sola vez, por si además se llega a
-- usar /setup o `bootstrap-first-admin` en el mismo despliegue.
INSERT INTO organizations (name, slug)
SELECT 'slaiton', 'slaiton'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'slaiton');

-- github_user_id queda NULL — se reclama solo en el primer login cuyo correo de GitHub
-- coincida (AuthService.resolveRegisteredUser).
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
