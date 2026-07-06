# 01 — Arquitectura general y componentes

## 1. Estilo arquitectónico

**Microservicios desacoplados orientados a eventos**, agrupados por *bounded context*, con:

- Un **API Gateway / BFF GraphQL** como única puerta de entrada síncrona para el dashboard.
- Un **bus de eventos** (async) como columna vertebral de la comunicación entre servicios de dominio.
- **Webhooks entrantes** de los proveedores Git como disparador externo.
- **Kubernetes** como plataforma de ejecución, incluyendo la ejecución de pipelines de calidad y sandboxes de tests en Jobs efímeros.
- **Multi-tenancy transversal**: todo servicio que persiste datos lo hace con `organization_id` (tenant) como partición lógica obligatoria.

## 2. Vista de contenedores (C4 — nivel 2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENTES                                       │
│   Dashboard Web (Next.js)     CLI      Integraciones (Slack/Jira/Teams)     │
└───────────────┬───────────────────────────────┬─────────────────────────────┘
                │ GraphQL/HTTPS                  │ REST/Webhooks salientes
                ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    API GATEWAY / BFF (GraphQL Federation)                   │
│         AuthN (OIDC) · Rate limiting · Tenant resolution · Caching          │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ gRPC/REST internos
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  IDENTITY &      GIT INTEGRATION     PROJECTS &        NOTIFICATION         │
│  TENANT SVC      SERVICE             DASHBOARD AGGR.   SERVICE              │
└───────┬──────────────┬───────────────────┬──────────────────┬───────────────┘
        │              │                   │                  │
        └──────────────┴─────────┬─────────┴──────────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │      BUS DE EVENTOS       │   (Kafka / RabbitMQ+BullMQ)
                     └────────────┬────────────┘
        ┌──────────────┬──────────┼──────────┬───────────────┬───────────────┐
        ▼              ▼          ▼          ▼               ▼               ▼
 ┌───────────┐  ┌─────────────┐ ┌────────┐ ┌──────────┐ ┌───────────┐ ┌─────────────┐
 │ AI CODE   │  │ VIRTUAL     │ │ TEST   │ │ QUALITY  │ │ SECURITY  │ │ DEPLOYMENT  │
 │ REVIEW    │  │ ARCHITECT   │ │ GEN.   │ │ PIPELINE │ │ SCANNING  │ │ MANAGEMENT  │
 │ AGENT     │  │ SERVICE     │ │ SVC    │ │ ORCHESTR.│ │ SERVICE   │ │ SERVICE     │
 └─────┬─────┘  └──────┬──────┘ └───┬────┘ └────┬─────┘ └─────┬─────┘ └──────┬──────┘
       │               │            │           │             │              │
       └───────────────┴────────────┴─────┬─────┴─────────────┴──────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │   RUNNERS / SANDBOX EXEC   │  (K8s Jobs + gVisor/Kata)
                              │   (Argo Workflows engine)  │
                              └────────────────────────────┘

  Almacenamiento: PostgreSQL (multi-tenant) · Redis · Qdrant/pgvector (embeddings)
                  OpenSearch (findings/logs) · S3/MinIO (artefactos, reportes, SBOM)
```

## 3. Catálogo de microservicios

Cada servicio es dueño exclusivo de sus datos (*database-per-service* lógico, aunque varios puedan compartir clúster de Postgres con esquemas separados en fases tempranas).

### 3.1 Identity & Tenant Service
- **Responsabilidad:** organizaciones, usuarios, membresías, roles (RBAC), conexiones OAuth/App a GitHub/GitLab/Bitbucket, API keys.
- **Expone:** GraphQL/REST interno `Organizations`, `Users`, `Roles`, `GitConnections`.
- **Eventos que produce:** `tenant.created`, `tenant.suspended`, `git_connection.linked`, `git_connection.revoked`.
- **Notas:** único servicio con acceso a tokens de proveedores Git (cifrados, ver doc 05).

### 3.2 Git Integration Service
- **Responsabilidad:** abstrae GitHub/GitLab/Bitbucket detrás de una interfaz canónica (`GitProviderPort`). Sincroniza repos, ramas, PRs, commits. Publica comentarios/status checks. Gestiona el registro/rotación de webhooks por repo.
- **Expone:** `GET /repos`, `POST /reviews/{id}/comments`, `POST /checks`.
- **Consume:** `review.completed`, `quality_gate.evaluated` (para publicar comentarios/checks).
- **Produce:** `code_change.received` (push/PR normalizado), `pr.opened`, `pr.updated`, `pr.merged`.
- **Patrón clave:** *Adapter* por proveedor (`GithubAdapter`, `GitlabAdapter`, `BitbucketAdapter`) implementando el mismo puerto — añadir un proveedor nuevo no toca al resto del sistema.

### 3.3 Webhook Ingestion Gateway
- **Responsabilidad:** único componente expuesto a internet para recibir webhooks. Verifica firma HMAC, deduplica por `delivery_id`, encola el payload crudo y responde `200` en <300ms.
- **Por qué existe separado del Git Integration Service:** los proveedores Git reintentan o desactivan webhooks que no responden rápido; aislar la ingesta evita que un picviado de procesamiento (LLM, etc.) tumbe la recepción de eventos.
- **Produce:** `webhook.raw_received` (a la cola, no al bus principal, para no acoplar el formato crudo del proveedor al resto del sistema).

### 3.4 AI Code Review Agent Service
- **Responsabilidad:** orquesta la revisión de IA a nivel de **diff** (push/PR). Ver detalle completo en [04](04-agente-ia-arquitecto.md).
- **Consume:** `code_change.received`.
- **Produce:** `review.started`, `review.completed` (incluye score, riesgo, hallazgos), `review.finding.created` (uno por hallazgo, consumido por la dashboard aggregation para timelines).
- **Llama (síncrono saliente):** Test Execution Service (para validar sugerencias), Git Integration Service (para postear comentarios).

### 3.5 Virtual Architect Service
- **Responsabilidad:** análisis estructural del **repositorio completo** (no el diff): god classes/services, violaciones SOLID, dependencias circulares, N+1, código muerto, duplicación, riesgos de escalabilidad. Genera propuestas de refactor concretas, opcionalmente como PR borrador.
- **Disparo:** cron por repo (configurable, p. ej. nightly), o on-demand, o tras N merges acumulados.
- **Consume:** `pr.merged` (para decidir recontar), tareas programadas.
- **Produce:** `architecture_report.created`, `refactor_proposal.created`.

### 3.6 Test Generation Service
- **Responsabilidad:** genera pruebas unitarias/integración para código nuevo o sin cobertura, las ejecuta en sandbox para verificar que compilan y pasan, y las ofrece como sugerencia/commit en el PR.
- **Consume:** `review.completed` (cuando detecta gaps de cobertura), solicitud manual desde el dashboard.
- **Llama:** Test Execution Service.
- **Produce:** `tests.generated`, `tests.suggestion_ready`.

### 3.7 Quality Pipeline Orchestrator
- **Responsabilidad:** el "cerebro" de CI. Define y ejecuta **quality gates** configurables por proyecto (tests unitarios/integración/funcionales, cobertura mínima, lint, SAST, SCA, secretos). Traduce la configuración del tenant en un `Workflow` de Argo Workflows, lo ejecuta en K8s, agrega resultados y emite la decisión pasa/bloquea.
- **No reimplementa** un motor de pipelines: es una capa de configuración + agregación + políticas sobre Argo Workflows.
- **Consume:** `code_change.received`, `review.completed`, `security_scan.completed`, `test_run.completed`.
- **Produce:** `pipeline.started`, `pipeline.step_completed`, `quality_gate.evaluated` (pasa/bloquea + razones).

### 3.8 Security Scanning Service
- **Responsabilidad:** SAST (Semgrep/CodeQL), SCA/dependencias vulnerables (Trivy/Grype/OSV), secret scanning (Gitleaks), generación de SBOM (Syft).
- **Por qué es un servicio separado del orchestrator:** tiene ciclo de vida propio (bases de reglas/CVE que se actualizan a diario, independiente de los despliegues del resto de la plataforma) y requisitos de compliance propios (reportes para auditoría).
- **Produce:** `security_scan.completed` (con hallazgos clasificados por severidad CVSS).

### 3.9 Test Execution / Runners Service
- **Responsabilidad:** ejecuta tests (generados por IA o del repo) en sandboxes efímeros aislados por lenguaje/framework (Node, PHP/Laravel, Angular/Karma, etc.), usando K8s Jobs con runtime aislado (gVisor/Kata Containers) y sin acceso a red salvo allowlist.
- **Expone:** `POST /executions` (idempotente, con timeout y límites de recursos).
- **Produce:** `test_run.completed` (resultados, cobertura).

### 3.10 Deployment Management Service
- **Responsabilidad:** ambientes (dev/QA/staging/prod), releases, historial de despliegues, changelogs autogenerados (conventional commits → semver), flujos de aprobación configurables, integración con el ejecutor de despliegue real (Argo CD / Helm / API del proveedor cloud o webhook al CD del cliente).
- **Consume:** `quality_gate.evaluated` (solo releases con gate verde pueden promoverse), `approval.granted`.
- **Produce:** `release.created`, `deployment.requested`, `deployment.approved`, `deployment.completed`, `changelog.generated`.

### 3.11 Notification Service
- **Responsabilidad:** enruta eventos relevantes a Slack/MS Teams/email/in-app según preferencias del tenant.
- **Consume:** prácticamente todos los eventos de dominio (vía suscripción configurable), no produce eventos de negocio.

### 3.12 Dashboard Aggregation API (BFF GraphQL)
- **Responsabilidad:** agrega datos de los servicios de dominio en las vistas que necesita el frontend (estado de proyectos, PRs pendientes, despliegues, cobertura, pipeline). Usa **GraphQL Federation** (Apollo Router) sobre subgrafos expuestos por cada servicio, evitando que el frontend dependa de N endpoints REST.
- **Resuelve real-time** vía GraphQL Subscriptions (WebSocket) respaldadas por el bus de eventos.

### 3.13 Reporting & Analytics Service
- **Responsabilidad:** métricas históricas y DORA metrics (deployment frequency, lead time for changes, change failure rate, MTTR), tendencias de calidad/cobertura por repo y por organización.
- **Fuente de datos:** consume eventos y materializa vistas analíticas (probablemente en un esquema OLAP-friendly o ClickHouse en fases avanzadas).

### 3.14 Audit Log Service
- **Responsabilidad:** registro inmutable de toda acción sensible (quién aprobó qué despliegue, quién cambió un quality gate, quién desactivó un check). Requisito clave para el tier Enterprise (SOC2/ISO27001).
- **Patrón:** *event sourcing* de solo-apéndice; se alimenta pasivamente del bus de eventos, no requiere que otros servicios lo llamen explícitamente.

## 4. Patrones de comunicación

| Tipo | Cuándo se usa | Tecnología |
|---|---|---|
| **Síncrono externo** | Frontend ↔ Gateway, integraciones salientes a APIs de GitHub/GitLab/Bitbucket | GraphQL (federado) / REST |
| **Síncrono interno** | Llamadas que necesitan respuesta inmediata para continuar un flujo (p. ej. Review Agent → Test Execution para validar una sugerencia) | gRPC (contratos fuertes, bajo overhead) |
| **Asíncrono (dominio)** | Todo lo que dispara trabajo de fondo: push/PR recibido, review completado, pipeline evaluado, despliegue solicitado | Bus de eventos (Kafka en V2+/Enterprise; RabbitMQ o BullMQ sobre Redis en MVP/V1) |
| **Webhooks entrantes** | Eventos de GitHub/GitLab/Bitbucket | HTTPS firmado (HMAC), un único punto de entrada (Webhook Ingestion Gateway) |
| **Webhooks/Integraciones salientes** | Notificar a Slack/Jira/Teams/CD del cliente | HTTPS firmado, con reintentos y *dead-letter* |

**Por qué empezar con BullMQ/RabbitMQ y migrar a Kafka más adelante:** en el MVP, la prioridad es velocidad de entrega y simplicidad operativa. BullMQ (sobre Redis) ya cubre colas, reintentos, *backoff* y *dead-letter* con muy poca infraestructura. Kafka aporta *replay* de eventos, *event sourcing* real y *throughput* masivo multi-consumidor — valioso cuando el volumen de organizaciones/repos crece y cuando Enterprise exige auditoría/replay, pero es sobre-ingeniería para los primeros clientes.

## 5. Catálogo de eventos de dominio (resumen)

| Evento | Productor | Consumidores principales |
|---|---|---|
| `code_change.received` | Git Integration Service | AI Code Review Agent, Quality Pipeline Orchestrator |
| `pr.opened` / `pr.updated` / `pr.merged` | Git Integration Service | Quality Pipeline Orchestrator, Virtual Architect, Reporting |
| `review.completed` | AI Code Review Agent | Quality Pipeline Orchestrator, Test Generation Service, Notification, Dashboard |
| `architecture_report.created` | Virtual Architect Service | Dashboard, Notification |
| `refactor_proposal.created` | Virtual Architect Service | Git Integration Service (abre PR borrador), Dashboard |
| `security_scan.completed` | Security Scanning Service | Quality Pipeline Orchestrator, Dashboard |
| `test_run.completed` | Test Execution Service | Quality Pipeline Orchestrator, Test Generation Service |
| `quality_gate.evaluated` | Quality Pipeline Orchestrator | Git Integration Service (status check), Deployment Management, Notification |
| `release.created` / `deployment.requested` / `deployment.approved` / `deployment.completed` | Deployment Management Service | Notification, Dashboard, Audit Log |
| `changelog.generated` | Deployment Management Service | Dashboard, Notification |

Todos los eventos se versionan (`v1.review.completed`) y se serializan con un esquema (Avro/JSON Schema) registrado en un *schema registry*, para permitir evolución sin romper consumidores.

## 6. Stack tecnológico recomendado

| Capa | Tecnología | Justificación |
|---|---|---|
| Lenguaje/runtime backend | **TypeScript + NestJS** (mayoría de servicios) | Tipado fuerte, DI nativa, ecosistema maduro para GraphQL/gRPC/colas, fácil de contratar |
| Servicios de alto throughput (Enterprise) | **Go** (candidato para Webhook Ingestion Gateway y Runners a escala) | Concurrencia ligera, footprint bajo, ideal para el único componente expuesto a internet |
| API pública/dashboard | **GraphQL Federation (Apollo Router/Gateway)** | El dashboard necesita vistas agregadas y anidadas (proyecto → PRs → checks → despliegues); evita *over-fetching* y N llamadas REST |
| Webhooks/integraciones salientes | **REST** | Es el lenguaje nativo de los proveedores Git |
| Comunicación interna síncrona | **gRPC + Protobuf** | Contratos fuertes entre servicios internos, bajo overhead |
| Bus de eventos | **Redis + BullMQ (MVP/V1) → Kafka (V2/Enterprise)** | Ver sección 4 |
| Base de datos transaccional | **PostgreSQL** (con Row-Level Security por `organization_id`) | Madurez, RLS nativo para multi-tenancy, soporte `pgvector` para embeddings sin sumar otro motor en fases tempranas |
| Vector store (RAG) | **pgvector (MVP/V1) → Qdrant dedicado (V2/Enterprise)** | Empezar simple sobre Postgres; migrar cuando el volumen de embeddings por repo lo justifique |
| Cache / rate limiting / colas | **Redis** | Estándar de facto, ya requerido por BullMQ |
| Búsqueda de hallazgos/logs | **OpenSearch** | Full-text + filtros facetados sobre miles de *findings* por organización |
| Almacenamiento de artefactos | **S3-compatible (MinIO on-prem / S3 en cloud)** | Diffs grandes, reportes, SBOM, logs de pipeline |
| Orquestación de pipelines | **Docker sibling containers en MVP → Argo Workflows sobre Kubernetes desde V1** | El MVP ejecuta los pasos de calidad directamente desde el `worker`; K8s/Argo se introduce cuando el volumen lo justifica (ver [08](08-mvp-fase0-stack.md)) |
| Sandboxing de ejecución de código | **Docker sibling containers endurecidos en MVP → K8s Jobs + gVisor/Kata desde V1** | Aísla la ejecución de tests/código generado por IA; el aislamiento a nivel de kernel (gVisor/Kata) llega con K8s, no es necesario para los primeros clientes piloto |
| LLM / agente de IA | **Modelo open-source (Qwen2.5-Coder) vía proveedor de inferencia administrada en MVP/V1 — intercambiable por Claude/GPT/modelo on-prem en Enterprise** | Sin operar GPU propia desde el día uno, sin costo de licencia de modelo; el `LlmPort` (ver [04](04-agente-ia-arquitecto.md)) abstrae el backend para que cambiar de proveedor o modelo sea configuración, no código |
| Modelo de embeddings (RAG) | **Open-source local vía Transformers.js (`Xenova/bge-small-en-v1.5`)** | Corre en CPU dentro del propio `worker` (Node.js), sin GPU ni servicio adicional — suficiente para el volumen de un repo individual |
| Frontend | **Next.js + TypeScript + TanStack Query + Tailwind/shadcn-ui** | SSR para carga inicial rápida del dashboard, ecosistema React maduro |
| Auth | **GitHub App (OAuth de usuario a servidor) + JWT propio en MVP → Keycloak/OIDC desde V1/Enterprise** | El MVP solo tiene un proveedor (GitHub), así que su propio flujo de login ya cubre autenticación y acceso a repos; Keycloak se introduce cuando hay SSO/SAML real que resolver |
| Contenedores/orquestación | **Docker Compose en MVP → Docker + Kubernetes (Helm) desde V1** | Un único `docker compose up` reduce la superficie operativa del primer despliegue; K8s entra cuando hace falta escalar horizontalmente o aislar con gVisor/Kata |
| GitOps de la propia plataforma | **Argo CD** | Despliegue declarativo y auditable de la plataforma misma |
| Observabilidad | **OpenTelemetry + Prometheus + Grafana + Loki + Tempo/Jaeger** | Estándar CNCF, traza distribuida a través de microservicios |
| CI de la plataforma (no del cliente) | **GitHub Actions** (para construir/testear/publicar la propia plataforma) | Dogfooding: la plataforma puede eventualmente auto-gestionarse |

> Nota: nada impide que un cliente Enterprise traiga su propio runner de ejecución (self-hosted runners), su propio LLM on-prem, o su propia base de datos dedicada — ver [05](05-seguridad-multitenancy-escalabilidad.md).
>
> Para las decisiones concretas y ya cerradas de la primera fase implementable (Fase 0), ver [08 - Stack del MVP](08-mvp-fase0-stack.md).
