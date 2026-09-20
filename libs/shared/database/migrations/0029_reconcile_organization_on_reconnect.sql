-- `link_installation_to_organization` (migraciones 0015/0027) solo reasignaba
-- `github_installations`/`repositories` al reconectar una instalación. Cada tabla del
-- esquema tiene su PROPIA columna `organization_id` con su propia política RLS —
-- ninguna hereda el aislamiento vía JOIN — así que un repo con historia de antes de
-- este sistema multi-App (por ejemplo, de cuando `ensureOrganization()`, ya retirado,
-- creaba una organización nueva por cada cuenta de GitHub instalada) queda con
-- `pull_requests`/`review_runs`/`findings`/`issues`/`developers`/etc. todavía bajo la
-- organización vieja — invisibles por RLS aunque el repo ya "pertenezca" a la nueva.
--
-- Esta función deja el `organization_id` de TODO lo que cuelga de un repo en línea con
-- el `organization_id` actual de `repositories` — se puede llamar tantas veces como
-- haga falta (no-op si ya está todo alineado). Se excluyen a propósito
-- `environments`/`deployments`/`audit_logs`/`promotions`/`pipeline_runs`: ninguna
-- consulta de la app las usa hoy (funcionalidad sin terminar), así que no vale la pena
-- el riesgo de tocarlas.
CREATE FUNCTION reconcile_repository_organization(p_repository_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id FROM repositories WHERE id = p_repository_id;
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE pull_requests SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;
  UPDATE quality_gate_configs SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;
  UPDATE code_chunk_embeddings SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;
  UPDATE repository_members SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;
  UPDATE project_profiles SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;
  UPDATE issues SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;

  UPDATE issue_comments ic SET organization_id = v_org_id
  FROM issues i
  WHERE ic.issue_id = i.id AND i.repository_id = p_repository_id AND ic.organization_id <> v_org_id;

  UPDATE review_runs SET organization_id = v_org_id
    WHERE repository_id = p_repository_id AND organization_id <> v_org_id;

  UPDATE findings f SET organization_id = v_org_id
  FROM review_runs rr
  WHERE f.review_run_id = rr.id AND rr.repository_id = p_repository_id AND f.organization_id <> v_org_id;

  -- developers no cuelga de repository_id (es una identidad a nivel de organización),
  -- así que se reconcilian los que quedaron referenciados desde review_runs de este
  -- repo — salvo que ya exista un developer con el mismo login/email en la
  -- organización destino (login/email son únicos por organización): en ese caso se
  -- deja como está, para no romper esa restricción ni la migración completa.
  UPDATE developers dv SET organization_id = v_org_id
  WHERE dv.id IN (
      SELECT developer_id FROM review_runs
      WHERE repository_id = p_repository_id AND developer_id IS NOT NULL
    )
    AND dv.organization_id <> v_org_id
    AND NOT EXISTS (
      SELECT 1 FROM developers dv2
      WHERE dv2.organization_id = v_org_id
        AND dv2.id <> dv.id
        AND (
          (dv.github_login IS NOT NULL AND dv2.github_login = dv.github_login)
          OR (dv.email IS NOT NULL AND dv2.email = dv.email)
        )
    );
END;
$$;
REVOKE ALL ON FUNCTION reconcile_repository_organization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_repository_organization(uuid) TO devsentinel_app;

-- Cada reconexión futura (botón "Conectar"/"Sincronizar instalaciones existentes")
-- reconcilia automáticamente, sin depender de que alguien recuerde correr nada a mano.
CREATE OR REPLACE FUNCTION link_installation_to_organization(
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
  v_repo_id uuid;
BEGIN
  INSERT INTO github_installations (organization_id, installation_id, account_login, status, github_app_id)
  VALUES (p_organization_id, p_installation_id, p_account_login, 'active', p_github_app_id)
  ON CONFLICT (installation_id) DO UPDATE
    SET organization_id = p_organization_id, status = 'active', github_app_id = p_github_app_id
  RETURNING id INTO v_installation_row_id;

  UPDATE repositories SET organization_id = p_organization_id
  WHERE github_installation_id = v_installation_row_id;

  FOR v_repo_id IN SELECT id FROM repositories WHERE github_installation_id = v_installation_row_id LOOP
    PERFORM reconcile_repository_organization(v_repo_id);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION link_installation_to_organization(bigint, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION link_installation_to_organization(bigint, uuid, text, uuid) TO devsentinel_app;

-- Backfill inmediato: arregla ahora mismo cualquier repo que ya haya quedado
-- desalineado (p. ej. por una reconexión hecha antes de que existiera esta función).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM repositories LOOP
    PERFORM reconcile_repository_organization(r.id);
  END LOOP;
END;
$$;
