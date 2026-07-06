# 06 — Estructura de carpetas

## 1. Decisión: monorepo (Nx) con despliegue independiente por servicio

**Monorepo**, no polyrepo, gestionado con **Nx** (alternativa válida: Turborepo). Razones:

- Los contratos compartidos (esquemas de eventos, subgraphs GraphQL, el `LlmPort`, los adapters de proveedores Git) cambian junto con varios servicios a la vez — un monorepo permite un único PR atómico cuando se actualiza un contrato, en vez de coordinar versiones entre N repos.
- Nx calcula qué servicios se ven afectados por un cambio (`nx affected`) y solo construye/testea/despliega esos — evita el costo de CI de un monorepo ingenuo.
- **No implica despliegue acoplado:** cada carpeta bajo `apps/` sigue empaquetándose como su propia imagen Docker y su propio deployment de Kubernetes, con su propio ciclo de release.

Si el equipo crece mucho y distintos servicios necesitan ciclos de release totalmente independientes con equipos dueños separados, dividir en polyrepo más adelante es una migración mecánica (Nx soporta extraer un proyecto a su propio repo conservando historial).

## 2. Árbol de carpetas (raíz)

```
devsentinel/
├── apps/                              # Unidades desplegables — 1 carpeta = 1 imagen Docker
│   ├── api-gateway/                   # BFF GraphQL Federation (Apollo Router)
│   ├── identity-tenant-svc/
│   ├── git-integration-svc/
│   ├── webhook-ingestion-gw/
│   ├── ai-review-agent-svc/
│   ├── virtual-architect-svc/
│   ├── test-generation-svc/
│   ├── quality-pipeline-orchestrator/
│   ├── security-scanning-svc/
│   ├── test-execution-svc/
│   ├── deployment-management-svc/
│   ├── notification-svc/
│   ├── reporting-analytics-svc/
│   ├── audit-log-svc/
│   └── dashboard-web/                 # Next.js — frontend del dashboard
│
├── libs/                              # Código compartido, no desplegable por sí solo
│   ├── shared/
│   │   ├── event-contracts/           # Esquemas de eventos versionados + tipos generados
│   │   ├── graphql-contracts/         # Subgraph schemas federados por servicio
│   │   ├── auth/                      # Validación JWT/OIDC, decoradores RBAC reutilizables
│   │   ├── observability/             # Setup común OpenTelemetry/logging estructurado
│   │   └── testing-utils/             # Fixtures, factories, mocks compartidos para tests
│   ├── domain/
│   │   ├── git-providers/             # GitProviderPort + GithubAdapter/GitlabAdapter/BitbucketAdapter
│   │   ├── llm-port/                  # Abstracción del proveedor LLM (Claude por defecto)
│   │   └── code-analysis/             # Parsing AST (tree-sitter), grafo de dependencias, clone detection
│   └── ui/                            # Design system compartido (componentes, tokens de Tailwind)
│
├── infra/
│   ├── helm/                          # Helm chart por servicio + umbrella chart de la plataforma
│   ├── argo-workflows/                # Plantillas de Workflow reutilizables para pipelines de calidad
│   ├── argo-cd/                       # Application manifests — GitOps de la propia plataforma
│   ├── terraform/                     # Clúster K8s, redes, KMS/Vault, bases de datos gestionadas
│   └── docker-compose/                # docker-compose.yml para desarrollo local sin K8s
│
├── docs/
│   └── architecture/                  # Este conjunto de documentos
│
├── scripts/                           # Bootstrap de entorno, seed de datos, migraciones, codegen
├── nx.json
├── package.json
└── README.md
```

## 3. Estructura interna de un servicio backend (ejemplo: `ai-review-agent-svc`)

```
apps/ai-review-agent-svc/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── orchestrator/
│   │   ├── review-orchestrator.service.ts     # Fan-out/fan-in de sub-agentes (ver doc 04)
│   │   ├── sub-agents/
│   │   │   ├── clean-code.agent.ts
│   │   │   ├── security.agent.ts
│   │   │   ├── architecture.agent.ts
│   │   │   ├── performance.agent.ts
│   │   │   └── docs.agent.ts
│   │   └── tools/                             # Implementación de tool-use: run_static_analyzer, etc.
│   ├── rag/
│   │   ├── indexing/                          # Indexación incremental diff-aware
│   │   └── retrieval/
│   ├── guardrails/                             # Motor de reglas deterministas sobre Finding[]
│   ├── events/
│   │   ├── consumers/                          # code_change.received → dispara revisión
│   │   └── producers/                          # review.completed, review.finding.created
│   ├── persistence/                            # Repositorios: ReviewRun, Finding, GeneratedTest
│   └── api/                                    # Resolvers/controllers internos (gRPC + subgraph GraphQL)
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
└── project.json                                # Configuración de build/test/lint de Nx
```

El resto de los servicios backend (`virtual-architect-svc`, `quality-pipeline-orchestrator`, etc.) siguen el mismo esqueleto (`events/`, `persistence/`, `api/`), variando solo la carpeta de dominio específica (`orchestrator/` en este caso).

## 4. Estructura del frontend (`dashboard-web`)

```
apps/dashboard-web/
├── app/                            # Next.js App Router
│   ├── (dashboard)/
│   │   ├── projects/[repoId]/
│   │   ├── pull-requests/[prId]/
│   │   ├── pipelines/[runId]/
│   │   ├── deployments/[envId]/
│   │   └── settings/
│   │       ├── quality-gates/
│   │       └── approval-flows/
│   └── api/                       # Route handlers ligeros (BFF-lite específico del frontend)
├── components/
│   ├── pull-request/
│   ├── pipeline-status/
│   └── deployment-map/
├── lib/
│   ├── graphql/                   # Queries/mutations + tipos generados (GraphQL Codegen)
│   └── hooks/
└── public/
```

## 5. Reglas de límites entre módulos (module boundaries)

Configuradas como reglas de lint de Nx (`@nx/enforce-module-boundaries`), no solo como convención documental:

- `apps/*` puede depender de `libs/*`, nunca de otro `apps/*` directamente (la comunicación entre servicios es siempre vía bus de eventos o el contrato gRPC/GraphQL definido en `libs/shared`, jamás importando código interno de otro servicio).
- `libs/domain/*` no puede depender de `libs/shared/observability` ni de ningún `apps/*` — el dominio es independiente de infraestructura.
- `libs/shared/event-contracts` no depende de nada dentro del monorepo — es la capa más estable, todo lo demás depende de ella.

Esto evita que el monorepo degenere en un *big ball of mud* donde "compartir carpeta" termine significando "acoplamiento oculto entre microservicios".
