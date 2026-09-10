-- Re-parenta una instalación de GitHub (y sus repos ya sincronizados, si los hay) a la
-- organización correcta de forma idempotente. Necesario porque el webhook
-- installation.created puede llegar antes o después del callback del navegador que
-- confirma a qué organización debe quedar ligada una cuenta de GitHub adicional —
-- SECURITY DEFINER porque github_installations/repositories tienen RLS y este flujo
-- no conoce el tenant "actual" de la sesión de BD hasta resolverlo aquí mismo (mismo
-- patrón que resolve_organization_for_installation, migración 0006).
CREATE FUNCTION link_installation_to_organization(
  p_installation_id bigint,
  p_organization_id uuid,
  p_account_login text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_installation_row_id uuid;
BEGIN
  INSERT INTO github_installations (organization_id, installation_id, account_login, status)
  VALUES (p_organization_id, p_installation_id, p_account_login, 'active')
  ON CONFLICT (installation_id) DO UPDATE
    SET organization_id = p_organization_id, status = 'active'
  RETURNING id INTO v_installation_row_id;

  UPDATE repositories SET organization_id = p_organization_id
  WHERE github_installation_id = v_installation_row_id;
END;
$$;

REVOKE ALL ON FUNCTION link_installation_to_organization(bigint, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION link_installation_to_organization(bigint, uuid, text) TO devsentinel_app;
