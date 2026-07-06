DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devsentinel_app') THEN
    RAISE EXCEPTION 'El rol devsentinel_app no existe - revisa que infra/postgres/init/01-app-role.sh se haya ejecutado al crear el volumen de Postgres';
  END IF;
END $$;

GRANT CONNECT ON DATABASE devsentinel TO devsentinel_app;
GRANT USAGE ON SCHEMA public TO devsentinel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devsentinel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devsentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devsentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO devsentinel_app;

-- Resolución de tenant a partir de un installation_id de GitHub: el único caso
-- legítimo donde hace falta leer github_installations sin conocer aún el tenant.
-- SECURITY DEFINER se ejecuta con los privilegios del owner (que sí ve todas las
-- filas), exponiendo solo esta consulta puntual, no un bypass general de RLS.
CREATE FUNCTION resolve_organization_for_installation(p_installation_id bigint)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM github_installations WHERE installation_id = p_installation_id;
$$;

REVOKE ALL ON FUNCTION resolve_organization_for_installation(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_organization_for_installation(bigint) TO devsentinel_app;
