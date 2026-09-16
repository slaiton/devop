-- Simplifica el modelo de roles a admin/user: 'owner' y 'viewer' nunca se llegaron a
-- usar desde código (solo 'admin' y 'developer' se insertan/chequean en la app), y
-- 'developer' se renombra a 'user' para que el modelo sea binario y explícito.
UPDATE org_memberships SET role = 'admin' WHERE role = 'owner';
UPDATE org_memberships SET role = 'user' WHERE role IN ('developer', 'viewer');

ALTER TABLE org_memberships DROP CONSTRAINT org_memberships_role_check;
ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_role_check CHECK (role IN ('admin', 'user'));

-- Repos asignados explícitamente a un usuario con rol "user": ve todos los review_runs
-- (commits/pushes/PRs) de esos repos, no solo los que él mismo envió. Un admin no
-- necesita filas aquí — ve todos los repos de la organización sin excepción.
CREATE TABLE repository_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, user_id)
);

ALTER TABLE repository_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON repository_members
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX repository_members_user_idx ON repository_members (user_id);
CREATE INDEX repository_members_repository_idx ON repository_members (repository_id);
