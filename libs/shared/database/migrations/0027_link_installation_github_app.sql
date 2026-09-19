-- `link_installation_to_organization` (migración 0015) re-parenta una instalación al
-- confirmarse desde el callback del navegador, pero nunca supo de qué GitHub App venía
-- esa instalación porque esa columna no existía todavía. Ahora que `github_installations`
-- tiene `github_app_id` (migración 0025) y el nuevo `GithubAppsModule` conecta Apps
-- concretas, la función necesita ese dato para dejar la instalación correctamente
-- ligada. Nada más llama a la firma de 3 argumentos (se quitó junto con el viejo login
-- por GitHub OAuth), así que se reemplaza en vez de sobrecargar.
DROP FUNCTION IF EXISTS link_installation_to_organization(bigint, uuid, text);

CREATE FUNCTION link_installation_to_organization(
  p_installation_id bigint,
  p_organization_id uuid,
  p_account_login text,
  p_github_app_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_installation_row_id uuid;
BEGIN
  INSERT INTO github_installations (organization_id, installation_id, account_login, status, github_app_id)
  VALUES (p_organization_id, p_installation_id, p_account_login, 'active', p_github_app_id)
  ON CONFLICT (installation_id) DO UPDATE
    SET organization_id = p_organization_id, status = 'active', github_app_id = p_github_app_id
  RETURNING id INTO v_installation_row_id;

  UPDATE repositories SET organization_id = p_organization_id
  WHERE github_installation_id = v_installation_row_id;
END;
$$;

REVOKE ALL ON FUNCTION link_installation_to_organization(bigint, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION link_installation_to_organization(bigint, uuid, text, uuid) TO devsentinel_app;
