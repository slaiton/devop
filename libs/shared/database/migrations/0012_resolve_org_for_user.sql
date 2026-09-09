-- org_memberships tiene RLS; resolver la organización de un usuario a partir de su
-- user_id (sin conocer aún el tenant) requiere el mismo patrón SECURITY DEFINER que
-- resolve_organization_for_installation (migración 0006).
CREATE FUNCTION resolve_organization_for_user(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM org_memberships WHERE user_id = p_user_id LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_organization_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_organization_for_user(uuid) TO devsentinel_app;
