# 02 — Modelo de datos

## 1. Principio multi-tenant

Toda tabla de negocio (excepto catálogos globales) tiene una columna `organization_id` **no nula** y **Row-Level Security (RLS)** activado en PostgreSQL, de forma que ninguna query pueda cruzar el límite de un tenant aunque haya un bug en la capa de aplicación. El tier Enterprise puede optar por esquema dedicado o base de datos dedicada (ver [05](05-seguridad-multitenancy-escalabilidad.md)), pero el modelo lógico es idéntico.

## 2. Dominios y entidades principales

### 2.1 Tenancy

```
Organization
├─ id, name, slug, plan_tier (free/pro/enterprise), created_at
├─ settings (jsonb: quality_gate_defaults, branding, etc.)

Team
├─ id, organization_id, name

User
├─ id, email, name, auth_provider_id (Keycloak sub)

OrgMembership
├─ id, organization_id, user_id, role (owner|admin|developer|viewer), team_id?

ApiKey
├─ id, organization_id, name, hashed_key, scopes[], expires_at
```

### 2.2 Integración Git (SCM)

```
GitProviderConnection
├─ id, organization_id, provider (github|gitlab|bitbucket)
├─ installation_id, encrypted_credentials (ref a KMS/Vault), status

Repository
├─ id, organization_id, git_provider_connection_id
├─ provider_repo_id, full_name, default_branch, language_primary[]
├─ webhook_status, last_synced_at

Branch
├─ id, repository_id, name, is_protected, last_commit_sha

Commit
├─ id, repository_id, sha, author, message, pushed_at

PullRequest
├─ id, repository_id, provider_pr_id, number, title, source_branch, target_branch
├─ author, status (open|merged|closed), created_at, merged_at

PullRequestComment
├─ id, pull_request_id, finding_id?, file_path, line, body, posted_by (ai_agent|user)
```

**Relaciones clave:** `Organization 1—N Repository` (vía `GitProviderConnection`); `Repository 1—N PullRequest`; `PullRequest 1—N PullRequestComment`.

### 2.3 Revisión de IA y arquitectura

```
ReviewRun
├─ id, organization_id, repository_id, pull_request_id?, commit_sha
├─ trigger (push|pull_request|manual), status (running|completed|failed)
├─ quality_score (0-100), risk_level (low|medium|high), started_at, completed_at

Finding
├─ id, review_run_id, category (architecture|clean_code|solid|security|performance
│   |duplication|complexity|best_practice|documentation|test_coverage)
├─ severity (info|low|medium|high|critical), file_path, line_start, line_end
├─ title, explanation, suggested_fix (diff/patch), rule_source (llm|semgrep|eslint|...)
├─ status (open|acknowledged|fixed|dismissed_false_positive)

ArchitectureReport
├─ id, organization_id, repository_id, generated_at
├─ metrics (jsonb: complejidad ciclomática agregada, LOC por módulo, fan-in/out)
├─ summary

RefactorProposal
├─ id, architecture_report_id, type (god_class|circular_dependency|n_plus_one
│   |dead_code|duplication|low_cohesion|scalability)
├─ description, affected_files[], proposed_diff, draft_pr_url?, status

GeneratedTest
├─ id, review_run_id, repository_id, file_path, framework (jest|phpunit|jasmine|...)
├─ code, target_coverage_lines[], verified_passing (bool), suggestion_status
```

**Relaciones clave:** `ReviewRun 1—N Finding`; `ArchitectureReport 1—N RefactorProposal`; `ReviewRun 1—N GeneratedTest`. `Finding` puede vincularse 1—1 a un `PullRequestComment` cuando se publica.

### 2.4 Pipelines y quality gates

```
QualityGateConfig
├─ id, organization_id, repository_id (null = default de la organización)
├─ min_coverage_pct, block_on_risk_level (medium|high), required_checks[]
├─ required_approvals_for_prod, custom_rules (jsonb)

PipelineRun
├─ id, organization_id, repository_id, pull_request_id?, commit_sha
├─ argo_workflow_name, status (pending|running|succeeded|failed|blocked)
├─ started_at, completed_at

PipelineStep
├─ id, pipeline_run_id, name (lint|unit_test|integration_test|sast|sca|secret_scan|...)
├─ status, logs_url, started_at, completed_at

TestSuiteResult
├─ id, pipeline_step_id, suite_type (unit|integration|functional)
├─ total, passed, failed, skipped, duration_ms

CoverageReport
├─ id, pipeline_step_id, line_coverage_pct, branch_coverage_pct, report_url

QualityGateEvaluation
├─ id, pipeline_run_id, quality_gate_config_id, passed (bool)
├─ blocking_reasons[] (jsonb), evaluated_at
```

**Relaciones clave:** `PipelineRun 1—N PipelineStep`; `PipelineStep 1—1 TestSuiteResult|CoverageReport` (según tipo); `PipelineRun 1—1 QualityGateEvaluation`.

### 2.5 Seguridad

```
SecurityFinding
├─ id, organization_id, repository_id, pipeline_run_id?, review_run_id?
├─ type (sast|dependency_cve|secret_exposed|sbom_risk)
├─ severity (cvss_score), cve_id?, file_path, line?, package_name?, package_version?
├─ status (open|remediated|accepted_risk), detected_at

SbomEntry
├─ id, repository_id, package_name, version, license, ecosystem (npm|composer|...)
```

### 2.6 Despliegues y releases

```
Environment
├─ id, organization_id, repository_id, name (development|qa|staging|production)
├─ current_release_id, status (healthy|degraded|deploying)

Release
├─ id, organization_id, repository_id, version (semver), commit_sha
├─ changelog_id, status (candidate|blocked|ready|deployed|rolled_back)

Changelog
├─ id, release_id, generated_from (conventional_commits|pr_titles), content_markdown

Deployment
├─ id, release_id, environment_id, triggered_by, status (pending|approved|running
│   |succeeded|failed|rolled_back)
├─ started_at, completed_at

ApprovalFlow
├─ id, organization_id, environment_id, steps (jsonb: orden, roles requeridos, min_approvals)

ApprovalStep
├─ id, deployment_id, approval_flow_step_index, approver_id, decision (pending|approved|rejected)
├─ decided_at, comment
```

**Relaciones clave:** `Release 1—N Deployment` (un release puede desplegarse a varios ambientes en secuencia); `Deployment 1—N ApprovalStep`; `Environment 1—1 Release` (release actualmente activo).

### 2.7 Notificaciones y auditoría

```
NotificationChannel
├─ id, organization_id, type (slack|teams|email|webhook), config (jsonb), subscribed_events[]

AuditLog
├─ id, organization_id, actor (user_id|"ai_agent"|"system"), action, target_type, target_id
├─ metadata (jsonb), occurred_at   -- solo-apéndice, inmutable
```

## 3. Diagrama de relaciones (alto nivel)

```
Organization ──┬── OrgMembership ── User
               ├── GitProviderConnection ── Repository ──┬── Branch
               │                                          ├── PullRequest ── PullRequestComment
               │                                          ├── ReviewRun ──┬── Finding
               │                                          │               └── GeneratedTest
               │                                          ├── ArchitectureReport ── RefactorProposal
               │                                          ├── PipelineRun ──┬── PipelineStep
               │                                          │                 └── QualityGateEvaluation
               │                                          ├── SecurityFinding
               │                                          └── Environment ── Release ── Deployment ── ApprovalStep
               ├── QualityGateConfig
               ├── NotificationChannel
               └── AuditLog
```

## 4. Notas de implementación

- **Particionamiento:** `Finding`, `AuditLog`, `PipelineStep` crecen sin límite por tenant — particionar por `organization_id` + rango temporal desde el inicio (tablas particionadas de Postgres) evita migraciones dolorosas después.
- **Soft state vs. event log:** las tablas anteriores son el *estado actual* (read model). El historial completo de eventos vive en el bus/almacén de eventos (Kafka log o tabla `outbox` en MVP) y permite reconstruir analítica histórica sin sobrecargar las tablas transaccionales.
- **Outbox pattern:** cada servicio que escribe estado y publica un evento en la misma operación de negocio usa el patrón *transactional outbox* para garantizar at-least-once delivery sin perder consistencia entre su base de datos y el bus.
- **Embeddings:** los vectores de código (para RAG) se modelan como una tabla `CodeChunkEmbedding(repository_id, file_path, chunk_hash, embedding vector(1536), symbol_name, updated_at)` — ver [04](04-agente-ia-arquitecto.md).
