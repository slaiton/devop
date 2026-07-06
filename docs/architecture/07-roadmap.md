# 07 — Roadmap: MVP → V1 → V2 → Enterprise

Principio general: cada fase debe ser **usable y vendible por sí misma**, no un prototipo descartable. La abstracción multi-proveedor (`GitProviderPort`) y el modelo multi-tenant (RLS) se construyen correctamente desde el MVP precisamente para no rehacerlos después.

## Fase 0 — MVP (meses 1-4)

**Objetivo:** validar que la revisión de IA sobre PRs reales aporta valor suficiente para bloquear/aprobar merges, con un solo proveedor Git.

**Incluye:**
- Integración con **GitHub únicamente** (GitHub App + webhooks + Check Runs API). Un único GitHub App cubre instalación/acceso a repos y login (OAuth de usuario a servidor) — no se introduce Keycloak todavía.
- Servicio `api` + `worker` como **monolito modular** (no microservicios distribuidos): módulos internos `github-integration`, `review`, `guardrails`, `deployments`, ya separados por dominio para que extraerlos a servicios independientes en V1/V2 sea mecánico.
- `AI Code Review Agent` v1: un único prompt consolidado (no aún fan-out de sub-agentes) cubriendo clean code, SOLID básico, seguridad básica y rendimiento básico, vía un **modelo open-source (Qwen2.5-Coder) servido por un proveedor de inferencia administrada** (Together.ai o equivalente — ver [08](08-mvp-fase0-stack.md)). Postea comentarios en línea + comentario resumen con `quality_score` y `risk_level`.
- Secret scanning (Gitleaks) integrado desde el día uno — es barato y de altísimo valor/riesgo.
- Guardrails deterministas v1: bloqueo de merge (GitHub Check Run en `failure`) si `risk_level = high` o si se detecta un secreto.
- Lint + tests unitarios ejecutados en **contenedores Docker efímeros endurecidos**, lanzados por el propio `worker` (sin Kubernetes ni Argo todavía).
- Dashboard v1: login con GitHub, lista de repos conectados, lista de PRs con score/riesgo/estado del gate.
- Multi-tenancy con RLS desde el día uno (no se posterga — no añade complejidad de despliegue, solo una política a nivel de base de datos).
- Registro manual de despliegues (sin automatización de aprobación todavía): el equipo marca "versión X desplegada a [ambiente]" desde el dashboard.
- Despliegue exclusivamente vía **Docker Compose** (`docker compose up` con 6 contenedores: Caddy, web, api, worker, Postgres, Redis) — sin clúster de Kubernetes en esta fase.

**Explícitamente fuera de alcance:** GitLab/Bitbucket, generación de tests, arquitecto virtual, flujos de aprobación multi-paso, SAST/SCA completos (solo secretos), Kubernetes, GPU propia, Keycloak/SSO.

**Métricas de éxito:** tiempo desde push hasta comentario de revisión (< 5 min objetivo); ≥3-5 clientes piloto activos; tasa de falsos positivos percibida (encuesta) como línea base; al menos un caso real de bloqueo de un problema de seguridad/calidad genuino.

## Fase 1 — V1 (meses 5-7)

**Objetivo:** multi-proveedor real, quality gates configurables de verdad, y las primeras capacidades "wow" (generación de tests, arquitecto virtual).

**Incluye:**
- Extracción de los módulos del monolito `api`/`worker` del MVP a servicios independientes donde el acoplamiento ya duele (empezando por `ai-review-agent-svc` y `git-integration-svc`) — mecánica gracias a los límites de módulo ya respetados desde el MVP.
- Adapters de **GitLab y Bitbucket** sobre el mismo `GitProviderPort` (valida que la abstracción del MVP era correcta).
- `AI Code Review Agent` v2: arquitectura completa de sub-agentes en paralelo (clean code, security, architecture/SOLID, performance, docs) — ver [04](04-agente-ia-arquitecto.md).
- `Security Scanning Service` completo: SAST (Semgrep), SCA/dependencias (Trivy/Grype), SBOM (Syft).
- Primera introducción de **Kubernetes**: `Quality Pipeline Orchestrator` migrado de contenedores Docker sueltos a **Argo Workflows sobre K8s**, con `QualityGateConfig` configurable por proyecto (cobertura mínima, checks requeridos) y aislamiento de sandboxes vía gVisor/Kata.
- `Test Generation Service` v1 para 2 frameworks (p. ej. Jest y PHPUnit), con validación en sandbox antes de sugerir.
- `Virtual Architect Service` v1: análisis programado de repo completo (god classes, ciclos de dependencias, código muerto, duplicación) — informe en dashboard, **sin** apertura automática de PR todavía.
- `Deployment Management Service` v1: ambientes, historial de releases, changelog automático desde conventional commits, aprobación de un solo paso.
- `Notification Service`: Slack + email.
- Aislamiento multi-tenant por tiers (esquema dedicado para tier Business).
- Helm charts del stack completo — habilita instalación on-prem/self-host para clientes que lo requieran.

**Métricas de éxito:** clientes con repos en ≥2 proveedores distintos; % de PRs bloqueados que de otra forma habrían llegado a producción (medido retroactivamente con el cliente piloto); cobertura promedio de los repos activos mejora mes a mes; primeras sugerencias de test generadas aceptadas sin modificación.

## Fase 2 — V2 (meses 8-13)

**Objetivo:** profundizar la inteligencia (refactors automáticos, métricas DORA) y la robustez operativa para clientes más grandes.

**Incluye:**
- `Virtual Architect`: para propuestas de alto confidence/bajo riesgo, apertura automática de **PR borrador** con el refactor propuesto.
- Flujos de **aprobación multi-paso configurables** (N-of-M aprobadores, por rol, por ambiente).
- `Reporting & Analytics Service`: métricas DORA (deployment frequency, lead time, change failure rate, MTTR) y tendencias de calidad por organización/repo.
- Migración del bus de eventos de Redis/BullMQ a **Kafka** (replay, throughput, base para auditoría enterprise).
- Vector store dedicado (**Qdrant**) reemplazando pgvector para RAG a escala.
- Motor de **reglas custom por organización** (estándares propios más allá de los defaults).
- Soporte de **runners self-hosted** (el cliente ejecuta los pipelines en su propia infraestructura, el control plane permanece en la plataforma).
- API pública + integraciones (Jira, MS Teams, webhooks genéricos salientes).
- Service mesh (Istio) + mTLS interno.

**Métricas de éxito:** % de refactors propuestos que se mergean; mejora medible en métricas DORA de equipos adoptantes; primeros contratos que requieren runners self-hosted cerrados exitosamente.

## Fase 3 — Enterprise (meses 14-20+)

**Objetivo:** cumplir los requisitos contractuales/compliance de organizaciones grandes y habilitar despliegues totalmente aislados.

**Incluye:**
- **Multi-región** con anclaje de datos por región (residencia de datos).
- **SSO/SAML + SCIM** para provisión automática de usuarios.
- Paquete de despliegue **on-prem / air-gapped**, incluyendo enrutamiento del `LlmPort` a un modelo desplegado dentro del perímetro del cliente (BYO-model).
- Aislamiento físico completo por tenant (clúster/DB dedicada) como opción contractual.
- Auditoría completa para **SOC2 Type II / ISO27001**, retención y borrado configurables por contrato.
- Facturación basada en uso con asignación de costos por tenant.
- SLAs formales y soporte dedicado.

**Métricas de éxito:** certificación SOC2 Type II obtenida; contratos Enterprise firmados con cláusulas de aislamiento/compliance cumplidas; cumplimiento de SLA de uptime medido en producción.

## Vista resumida

| Fase | Duración acumulada | Hito clave |
|---|---|---|
| MVP | Meses 1-4 | Revisión de IA bloquea merges en GitHub, con clientes piloto reales |
| V1 | Meses 5-7 | Multi-proveedor + multi-agente + quality gates configurables + generación de tests |
| V2 | Meses 8-13 | Refactors automáticos + métricas DORA + Kafka + runners self-hosted |
| Enterprise | Meses 14-20+ | Multi-región, SSO/SCIM, on-prem, SOC2 |

> Las duraciones son estimaciones de planificación inicial, no compromisos — deben revisarse tras el cierre de cada fase con datos reales de velocidad del equipo y feedback de clientes piloto.
