# DevSentinel AI — Plataforma DevOps Inteligente

> Nombre de trabajo del producto: **DevSentinel AI**. Combina orquestación DevOps (estilo GitHub Actions), calidad de código (estilo SonarQube), revisión asistida por IA (estilo Copilot Code Review) y gestión de trabajo/aprobaciones (estilo Jira), añadiendo un agente de IA que actúa como **arquitecto de software y revisor automático**.

Este directorio contiene la propuesta de arquitectura completa, lista para servir de base de implementación. Está dividida en documentos independientes para facilitar su mantenimiento y revisión incremental.

## Índice de documentos

| # | Documento | Contenido |
|---|-----------|-----------|
| 01 | [Arquitectura y componentes](01-arquitectura-y-componentes.md) | Vista C4, microservicios, comunicación entre servicios, catálogo de eventos, stack tecnológico |
| 02 | [Modelo de datos](02-modelo-de-datos.md) | Entidades, relaciones, estrategia multi-tenant a nivel de datos |
| 03 | [Flujos de trabajo](03-flujos-de-trabajo.md) | Secuencias end-to-end: push/PR → revisión IA, pipeline de calidad, generación de tests, análisis arquitectónico, despliegues |
| 04 | [Agente de IA / Arquitecto virtual](04-agente-ia-arquitecto.md) | Diseño interno del agente, RAG sobre el código, contratos de salida, generación de tests, guardrails deterministas |
| 05 | [Seguridad, multi-tenancy y escalabilidad](05-seguridad-multitenancy-escalabilidad.md) | AuthN/AuthZ, aislamiento de tenants, sandboxing de ejecución, escalado |
| 06 | [Estructura de carpetas](06-estructura-carpetas.md) | Organización del monorepo y de cada servicio |
| 07 | [Roadmap](07-roadmap.md) | MVP → V1 → V2 → Enterprise, con alcance y métricas de éxito por fase |
| 08 | [Stack del MVP (Fase 0)](08-mvp-fase0-stack.md) | Decisiones ya cerradas para la primera fase: solo GitHub, IA open-source vía inferencia administrada, monolito modular, Docker Compose |

## Resumen ejecutivo

### El problema

Los equipos de desarrollo combinan hoy herramientas desconectadas: CI/CD (GitHub Actions/GitLab CI), calidad estática (SonarQube), revisión de código asistida (Copilot/CodeRabbit) y gestión de trabajo (Jira). Ninguna herramienta:

- Razona sobre **arquitectura completa del proyecto** (no solo el diff).
- Combina hallazgos deterministas (linters, SAST, SCA) con razonamiento de un LLM para explicar el *por qué* y proponer refactors concretos.
- Bloquea automáticamente merges/despliegues con una política configurable y auditable.
- Unifica el estado de repos, PRs, pipelines y despliegues multi-proveedor (GitHub/GitLab/Bitbucket) en un solo dashboard multi-tenant.

### La propuesta

Una plataforma **multi-tenant**, construida como **servicios desacoplados** alrededor de un **bus de eventos**, que:

1. Se conecta vía **GitHub Apps / GitLab Apps / Bitbucket Connect Apps** + webhooks a los repositorios de la organización.
2. Ante cada `push` o `pull_request`, dispara un **agente de IA orquestador** que combina analizadores deterministas (Semgrep, linters por lenguaje, SCA, secret scanning) con un LLM (Claude) que tiene acceso a contexto recuperado (RAG) del repositorio para razonar sobre el diff.
3. Publica el informe como comentarios en línea sobre el PR, un *quality score*, un nivel de riesgo y, si corresponde, **bloquea el merge** mediante el API de *status checks* del proveedor Git.
4. Ejecuta de forma periódica un **análisis arquitectónico completo del repositorio** (no solo el diff) para detectar god classes, violaciones SOLID, dependencias circulares, N+1, código muerto y duplicación, proponiendo refactors concretos.
5. Orquesta los **quality gates** (tests unitarios/integración/funcionales, cobertura mínima, SAST, SCA, secretos) antes de habilitar merge/deploy.
6. Gestiona **despliegues y releases**: estado por ambiente (dev/QA/staging/prod), changelogs automáticos, flujos de aprobación configurables.
7. Expone todo a través de un **dashboard centralizado** multi-organización.

### Principios de diseño rectores

1. **Lo determinista bloquea, lo probabilístico explica y sugiere.** Un LLM nunca es la única puerta de un bloqueo de seguridad crítico (secretos, CVEs críticos, cobertura). Esas decisiones las toma un motor de reglas determinista; el LLM aporta contexto, explicación y sugerencias de fix. Ver [04 - Agente de IA](04-agente-ia-arquitecto.md#guardrails-deterministas).
2. **Diff-aware, repo-aware.** La revisión de PR opera sobre el cambio (rápida, barata, enfocada). El análisis arquitectónico opera sobre el repo completo (profundo, periódico, costoso). Son dos servicios distintos con distinta cadencia.
3. **Todo es asíncrono salvo la ingesta de webhooks.** La única ruta síncrona crítica es "recibir webhook → validar firma → encolar → responder 200". Todo el procesamiento pesado ocurre fuera del request HTTP.
4. **Multi-tenant desde el día uno**, aunque el aislamiento físico (esquema/DB dedicada) se reserve como opción para el tier Enterprise.
5. **Cada proveedor Git (GitHub/GitLab/Bitbucket) se normaliza a un modelo de eventos y entidades canónico** antes de tocar el resto del sistema, para que ningún servicio interno conozca particularidades de un proveedor.
6. **El motor de orquestación de pipelines no se reinventa**: se construye sobre un motor de workflows nativo de Kubernetes (Argo Workflows) en lugar de escribir un programador de tareas propio.

### Estado actual

La Fase 0 (MVP) ya tiene stack cerrado: **solo GitHub**, **IA open-source (Qwen2.5-Coder) vía inferencia administrada** (sin GPU propia), **monolito modular** en vez de microservicios distribuidos, y despliegue 100% en **Docker Compose**. Ver [08 - Stack del MVP](08-mvp-fase0-stack.md) para el detalle y `docker-compose.yml` / `.env.example` en la raíz del repo para la topología real.

### Vista de un vistazo

```
Desarrollador → Push/PR → GitHub/GitLab/Bitbucket
                                  │ webhook
                                  ▼
                    [Webhook Ingestion Gateway]
                                  │ evento crudo
                                  ▼
                         [Bus de eventos]
                     ╱        │         ╲
        [Git Integration]  [AI Review]  [Quality Pipeline
         (normaliza,        Agent        Orchestrator]
         API providers)    (revisión IA)  (tests/SAST/SCA)
                     ╲        │         ╱
                          [Quality Gate]
                                  │ pasa / bloquea
                                  ▼
                    [Deployment Mgmt Service] → Ambientes (dev/QA/staging/prod)
                                  │
                                  ▼
                         [Dashboard multi-tenant]
```

Ver el diagrama C4 completo y el detalle de cada componente en [01 - Arquitectura y componentes](01-arquitectura-y-componentes.md).
