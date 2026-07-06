# 03 — Flujos de trabajo end-to-end

## Flujo A — Push / Pull Request dispara revisión de IA

1. El desarrollador hace `git push` o abre un PR en GitHub/GitLab/Bitbucket.
2. El proveedor envía un webhook → **Webhook Ingestion Gateway**: verifica firma HMAC, deduplica por `delivery_id`, encola el payload crudo en `webhook.raw_received` y responde `200 OK` en <300ms.
3. **Git Integration Service** consume la cola, traduce el payload específico del proveedor a un evento canónico `code_change.received` (incluye repo, rama, commit(s), diff URL, PR si aplica) y lo publica en el bus.
4. **AI Code Review Agent** consume `code_change.received`:
   a. Obtiene el diff real (vía API del proveedor).
   b. Recupera contexto relevante del repo mediante RAG (embeddings de archivos relacionados, no todo el repo).
   c. Ejecuta analizadores deterministas en paralelo (linter del lenguaje, Semgrep) sobre los archivos tocados.
   d. Pasa diff + hallazgos deterministas + contexto recuperado al orquestador LLM, que produce hallazgos estructurados (categoría, severidad, archivo/línea, explicación, fix sugerido).
   e. Calcula `quality_score` y `risk_level` agregados.
5. El servicio publica `review.completed` y, vía **Git Integration Service**, postea comentarios en línea sobre el PR y actualiza el *status check* (`pending` mientras corre, `success`/`failure` al terminar).
6. **Quality Pipeline Orchestrator**, que también consumió `code_change.received`, dispara en paralelo el pipeline de calidad (Flujo B). Cuando ambos —revisión IA y pipeline— terminan, evalúa el `QualityGateConfig` del repo.
7. Si hay hallazgos `critical`/`high` sin resolver, cobertura por debajo del mínimo, secretos expuestos o CVEs críticos: el *status check* se marca como `failure` con detalle y enlace al dashboard → **el merge queda bloqueado** a nivel de branch protection del proveedor Git.
8. El **Dashboard** se actualiza en tiempo real (GraphQL subscription) reflejando el nuevo estado del PR.

## Flujo B — Pipeline de calidad (quality gates)

1. Disparado por `code_change.received` o por `pr.opened`/`pr.updated`.
2. **Quality Pipeline Orchestrator** traduce el `QualityGateConfig` del repo en un `Workflow` de Argo (pasos: checkout → instalar dependencias → lint → tests unitarios → tests de integración → tests funcionales → cobertura → SAST → SCA → secret scanning → agregación).
3. Cada paso corre como **K8s Job** aislado (runtime gVisor/Kata), con límites de CPU/memoria y timeout. Los runners conocen el framework por convención de detección (package.json, composer.json, angular.json, etc.) o por configuración explícita del repo.
4. Resultados de cada paso se reportan a **Quality Pipeline Orchestrator** (`pipeline.step_completed`); en paralelo, **Security Scanning Service** reporta `security_scan.completed` y **Test Execution Service** reporta `test_run.completed` con datos de cobertura.
5. Al completarse todos los pasos requeridos, el Orchestrator agrega resultados contra `QualityGateConfig` y publica `quality_gate.evaluated` con el detalle de qué pasó y qué no.
6. Si el repo tiene release/branch protegida y el gate es verde, **Deployment Management Service** marca el commit como release candidate (Flujo E).

## Flujo C — Generación automática de tests

1. Disparo: `review.completed` detecta archivos/funciones nuevas sin cobertura suficiente, o el desarrollador lo solicita manualmente desde el dashboard/comentario en el PR (`/generate-tests`).
2. **Test Generation Service** recupera la función/clase objetivo + ejemplos de tests existentes en el repo (RAG, para imitar convenciones: estructura de *describe/it*, fixtures, mocks usados).
3. El LLM genera el código de test en el framework detectado (Jest/Vitest, PHPUnit, Jasmine/Karma, etc.).
4. El test generado se ejecuta en sandbox vía **Test Execution Service** para verificar que compila y pasa (o falla intencionalmente si es TDD sobre un bug).
5. Si pasa, el servicio publica `tests.suggestion_ready` y comenta en el PR con el bloque de código sugerido (o abre un commit directo en la rama del PR, según preferencia del repo) más una explicación de qué casos cubre y por qué.

## Flujo D — Análisis arquitectónico completo (arquitecto virtual)

1. Disparo: cron configurable por repo (p. ej. cada noche), acumulación de N merges, o solicitud manual.
2. **Virtual Architect Service** sincroniza el repo completo, construye:
   - Grafo de dependencias a nivel de módulo/clase (para detectar ciclos).
   - Métricas por archivo/clase (LOC, número de métodos públicos, fan-in/fan-out, complejidad ciclomática).
   - Patrones de acceso a datos (para detectar N+1: llamadas a ORM dentro de loops sobre colecciones ya cargadas).
   - Análisis de alcanzabilidad estático (para código muerto) y *clone detection* (para duplicación).
3. Los hallazgos deterministas se combinan con razonamiento del LLM para producir `RefactorProposal`: descripción del problema, por qué importa (impacto en mantenibilidad/escalabilidad/rendimiento), y un diff propuesto concreto.
4. Se publica `architecture_report.created`. Para propuestas de alta confianza y bajo riesgo (p. ej. extraer método, eliminar código muerto verificado), el servicio puede abrir automáticamente un **PR borrador** con el refactor (`refactor_proposal.created` → Git Integration Service abre el PR, marcado claramente como generado por IA y nunca auto-mergeable).
5. El equipo revisa el informe en el dashboard, prioriza propuestas por impacto/esfuerzo.

## Flujo E — Release, aprobación y despliegue

1. Un commit en una rama de release con `quality_gate.evaluated = passed` genera un `Release` candidato en **Deployment Management Service**.
2. El servicio genera el **changelog automático** a partir de conventional commits / títulos de PR desde el último release, y calcula la versión semver sugerida (major/minor/patch según tipos de cambio detectados).
3. Si el ambiente destino tiene un `ApprovalFlow` configurado (p. ej. producción requiere 2 aprobaciones de rol `admin`), se crea el `Deployment` en estado `pending` y **Notification Service** avisa a los aprobadores.
4. Cada aprobador decide (`approved`/`rejected`) desde el dashboard o un enlace directo de Slack. Al alcanzar el mínimo configurado, se publica `approval.granted`.
5. **Deployment Management Service** ejecuta el despliegue (vía Argo CD/Helm si la plataforma gestiona el clúster del cliente, o vía webhook hacia el CD propio del cliente) y actualiza `Environment.current_release_id`.
6. Resultado (`deployment.completed` o `deployment.failed`) se refleja en el dashboard: mapa de qué versión corre en cada ambiente (dev/QA/staging/prod), con posibilidad de **rollback** a un release anterior desde la misma vista.

## Flujo F — Resolución de hallazgos y aprendizaje continuo

1. Un desarrollador marca un `Finding` como `dismissed_false_positive` con un comentario explicando por qué.
2. Ese feedback se almacena y se usa como ejemplo few-shot futuro para ese repo/organización (reduce falsos positivos repetidos del mismo tipo) y, agregado, alimenta métricas de precisión del agente por categoría — visibles para el equipo de producto, no expuestas como "auto-tuning silencioso" sin trazabilidad.
3. Hallazgos marcados `fixed` se verifican automáticamente en el siguiente `ReviewRun` del mismo archivo (si el patrón ya no aparece, se cierra; si reaparece, se reabre con referencia al historial).
