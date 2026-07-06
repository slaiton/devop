# 08 — Stack del MVP (Fase 0)

Este documento fija las decisiones **concretas y ya cerradas** para la primera versión implementable: solo GitHub, IA open-source vía inferencia administrada, y un stack pensado para desplegarse con un único `docker compose up`. Donde la visión completa ([01](01-arquitectura-y-componentes.md)-[07](07-roadmap.md)) describía opciones a futuro, este documento elige una.

## 1. Qué cambia respecto a la visión completa, y por qué

| Decisión de la visión completa | Decisión del MVP | Por qué |
|---|---|---|
| 14 microservicios independientes | **Monolito modular**: 2 apps desplegables (`api`, `worker`) + `web` | Nadie ha validado el producto todavía. Separar en 14 servicios antes de tener un solo cliente real multiplica el costo operativo sin beneficio — los límites de módulo (sección 7) se respetan igual, así que extraer un servicio después es mover una carpeta, no reescribir |
| Bus de eventos (Kafka/RabbitMQ) | **Redis + BullMQ** | Ya estaba planeado como punto de partida en [01](01-arquitectura-y-componentes.md); se mantiene |
| Kubernetes + Argo Workflows + gVisor/Kata | **Docker Compose + contenedores Docker sibling endurecidos** | Un clúster K8s es la diferencia entre "`docker compose up` en una VM" y "necesitas a alguien que sepa operar Kubernetes". Se introduce en V1 cuando el volumen de pipelines concurrentes lo exija |
| LLM: Claude/GPT vía API propietaria, o modelo open-source autoalojado en GPU propia | **Modelo open-source vía proveedor de inferencia administrada** (sin GPU propia, sin modelo propietario) | Decisión explícita del usuario: IA open-source donde sea posible, sin asumir la operación de GPU. Ver sección 4 |
| Auth: Keycloak self-hosted (OIDC/SSO) | **GitHub App (OAuth de usuario a servidor) + JWT propio** | El único proveedor en MVP es GitHub — su propio login ya resuelve autenticación y autorización de acceso a repos. Keycloak vuelve cuando haya que dar SSO/SAML a compradores enterprise que no viven en GitHub |
| RAG: pgvector + embeddings vía proveedor o modelo grande | **pgvector + embeddings locales (Transformers.js, CPU)** | Los modelos de embedding son órdenes de magnitud más pequeños que el LLM generativo — correrlos localmente en el `worker` es gratis y evita una dependencia externa más |
| Revisión de IA: orquestador + 5 sub-agentes en paralelo | **Un único prompt consolidado** con el mismo contrato de salida | Menos llamadas al modelo = menor costo y menor superficie de fallo mientras se valida que el modelo/proveedor elegido produce hallazgos útiles. El contrato no cambia, así que pasar a fan-out en V1 no rompe nada aguas abajo |

Todo lo que NO aparece en esta tabla (modelo de datos, catálogo de eventos, `GitProviderPort`, `LlmPort`, RLS multi-tenant) se mantiene exactamente como en los documentos 01-07 — el MVP es un subconjunto fiel de la visión completa, no una rama distinta.

## 2. Stack tecnológico del MVP (decisivo)

| Capa | Tecnología elegida | Notas |
|---|---|---|
| Backend | **NestJS + TypeScript**, 2 apps: `api` (HTTP/GraphQL + webhooks) y `worker` (BullMQ consumer) | Mismo lenguaje que el frontend; módulos internos ya separados por dominio |
| Frontend | **Next.js + TypeScript + TanStack Query + Tailwind** | Sin cambios respecto a la visión completa |
| Base de datos | **PostgreSQL 16 con `pgvector`** (imagen `pgvector/pgvector:pg16`) | RLS activado desde la primera migración |
| Cola / cache | **Redis 7 + BullMQ** | Reintentos, backoff y dead-letter listos de fábrica |
| LLM (revisión de código) | **Qwen2.5-Coder-32B-Instruct**, servido por **Together.ai** (API compatible con OpenAI) | Apache 2.0, disponible también en Fireworks/DeepInfra/Groq — portabilidad sin reescribir código, solo cambiar config |
| Embeddings (RAG) | **`Xenova/bge-small-en-v1.5`** vía `@xenova/transformers` (ONNX, CPU, dentro del `worker`) | Sin GPU, sin servicio adicional |
| Análisis estático | **Semgrep** (reglas OWASP/genéricas) + **Gitleaks** (secretos) como procesos en contenedores Docker puntuales | CLIs gratuitas, sin licencia |
| Sandbox de tests/lint | **Contenedores Docker efímeros** lanzados por el `worker` vía `dockerode` (sibling containers) | Ver sección 5 — incluye el trade-off de seguridad aceptado para esta fase |
| Auth | **GitHub App** (instalación + OAuth de usuario a servidor) + **JWT** propio firmado por `api` | Un solo registro de GitHub App cubre login y acceso a repos |
| Reverse proxy / TLS | **Caddy 2** | HTTPS automático (Let's Encrypt) sin configuración manual de certificados |
| Despliegue | **Docker Compose**, 6 contenedores | Ver sección 3 |
| Observabilidad mínima | Logs estructurados (`pino`) a stdout + healthchecks de Compose | OpenTelemetry/Prometheus/Grafana se posponen a V1 — para el volumen del MVP, `docker compose logs` y las healthchecks bastan |

## 3. Topología de despliegue

```
                    ┌────────────┐
        HTTPS  ───▶ │   Caddy    │  (80/443, Let's Encrypt automático)
                    └─────┬──────┘
                ┌─────────┴─────────┐
                ▼                   ▼
          ┌──────────┐        ┌──────────┐
          │   web    │        │   api    │◀── webhooks de GitHub
          │ (Next.js)│        │ (NestJS) │
          └──────────┘        └────┬─────┘
                                    │ encola job
                                    ▼
                              ┌──────────┐        ┌─────────────────┐
                              │  worker  │───────▶│ Together.ai     │
                              │ (NestJS) │  HTTPS │ (Qwen2.5-Coder) │
                              └────┬─────┘        └─────────────────┘
                                    │ docker.sock (sibling containers)
                                    ▼
                          contenedores efímeros de test/lint
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                                       ▼
          ┌──────────┐                            ┌──────────┐
          │ postgres │                            │  redis   │
          │+pgvector │                            │ (BullMQ) │
          └──────────┘                            └──────────┘
```

6 contenedores definidos en `docker-compose.yml` (raíz del repo): `caddy`, `web`, `api`, `worker`, `postgres`, `redis`. El único servicio externo es el proveedor de inferencia del LLM — no hay GPU, no hay clúster, no hay control plane adicional que operar.

## 4. Integración con GitHub

**Un único GitHub App** (no OAuth App separada) cubre instalación y login:

- **Permisos de repositorio:** `Contents: Read`, `Pull requests: Read & Write`, `Checks: Read & Write`, `Metadata: Read`.
- **Eventos de webhook suscritos:** `push`, `pull_request`, `installation`, `installation_repositories`.
- **Login:** flujo OAuth de usuario a servidor nativo de GitHub Apps ("Sign in with GitHub App") — el mismo App que da acceso a los repos autentica al usuario; no se registra una OAuth App adicional.
- **Tokens de instalación:** de corta duración, renovados automáticamente por el módulo `github-integration` del `api`; cifrados en reposo (ver [05](05-seguridad-multitenancy-escalabilidad.md), aplicable también al MVP aunque sea una sola tabla con `pgcrypto` en vez de Vault).

## 5. Integración con el LLM

### 5.1 `LlmPort`: una interfaz, cualquier proveedor compatible con OpenAI

```typescript
interface LlmPort {
  reviewDiff(input: ReviewDiffInput): Promise<ReviewResult>;
  embed(text: string): Promise<number[]>;
}

class OpenAiCompatibleReviewAdapter implements LlmPort {
  private client: OpenAI;
  constructor(baseUrl: string, apiKey: string, private model: string) {
    this.client = new OpenAI({ baseURL: baseUrl, apiKey });
  }

  async reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_schema', json_schema: reviewResultJsonSchema },
      messages: buildSinglePassReviewPrompt(input),
    });
    const raw = JSON.parse(completion.choices[0].message.content);
    return reviewResultZodSchema.parse(raw); // lanza si no cumple el contrato de la sección 5 del doc 04
  }

  async embed(text: string): Promise<number[]> { /* ver 5.3 */ }
}
```

Cambiar de Together.ai a Fireworks/DeepInfra/Groq/OpenRouter, o más adelante a Claude, es cambiar `LLM_PROVIDER_BASE_URL` + `LLM_PROVIDER_API_KEY` + `LLM_MODEL` — cero cambios de código. Esto es intencional: el ecosistema de modelos abiertos cambia cada pocos meses, y la plataforma no debe quedar acoplada a la elección de hoy.

### 5.2 Proveedor y modelo por defecto

- **Modelo:** `Qwen/Qwen2.5-Coder-32B-Instruct` — Apache 2.0, de los mejores modelos abiertos en benchmarks de comprensión y revisión de código a la fecha de este documento.
- **Proveedor:** **Together.ai** — catálogo amplio de modelos abiertos (incluye variantes Qwen-Coder y DeepSeek-Coder), API compatible con OpenAI, soporte de modo JSON/schema y function calling.
- **Por qué este par y no otro:** el modelo está disponible en múltiples proveedores (Fireworks, DeepInfra, Groq lo añaden/quitan de su catálogo con el tiempo) — si Together.ai cambia condiciones, la migración es de configuración, no de prompt ni de parsing.
- **Verificar en el momento de implementar:** el catálogo y pricing de estos proveedores cambia con frecuencia; confirmar disponibilidad del modelo elegido y de modo JSON estricto antes de fijar el proveedor final.

### 5.3 Embeddings locales (sin GPU, sin proveedor externo)

```typescript
import { pipeline } from '@xenova/transformers';

const embedder = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');

async function embed(text: string): Promise<number[]> {
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
```

Corre en CPU dentro del proceso del `worker`, en ONNX vía `@xenova/transformers` — sin Python, sin GPU, sin contenedor adicional. Los vectores resultantes (384 dimensiones para `bge-small`) se guardan en la tabla `CodeChunkEmbedding` sobre `pgvector` ya descrita en [02](02-modelo-de-datos.md).

### 5.4 Revisión de un único paso (sin fan-out todavía)

El `worker`, al recibir `code_change.received`:
1. Ejecuta Semgrep + Gitleaks sobre los archivos del diff (determinista, antes de tocar el LLM).
2. Recupera contexto relacionado vía embeddings locales (5.3).
3. Construye **un único prompt** con: diff + hallazgos de Semgrep/Gitleaks + contexto recuperado, pidiendo el mismo JSON estructurado (`Finding[]`, `quality_score`, `risk_level`) definido en [04](04-agente-ia-arquitecto.md#5-contrato-de-salida-estructurado).
4. Valida la respuesta con un esquema Zod. Si falla, reintenta una vez con el error de validación incluido en el prompt; si falla otra vez, marca la revisión como `failed` y notifica — nunca persiste un hallazgo no validado.
5. Aplica los guardrails deterministas (secreto detectado → bloqueo; `risk_level: high` → bloqueo) y publica el *check run* en GitHub.

La arquitectura de sub-agentes en paralelo de [04](04-agente-ia-arquitecto.md#2-arquitectura-interna-orquestador--sub-agentes) queda lista para V1 sin cambios de contrato — solo se reemplaza el paso 3 por un fan-out.

## 6. Sandbox de ejecución de tests y lint

```typescript
const container = await docker.createContainer({
  Image: image,
  Cmd: cmd,
  WorkingDir: workdir,
  HostConfig: {
    Binds: ['devsentinel_workspace:/workspace'],
    NetworkMode: networkDisabled === false ? 'bridge' : 'none',
    Memory: 512 * 1024 * 1024,
    PidsLimit: 256,
    AutoRemove: true,
  },
});
// attach + start + wait con un timeout que mata el contenedor si se excede
```

(`SandboxRunnerService` en `apps/worker/src/modules/review/sandboxRunner.service.ts` — implementación real, no solo ilustrativa).

- El `worker` y los contenedores que lanza comparten el **volumen Docker nombrado** `devsentinel_workspace` montado en `/workspace` en ambos lados — es lo que hace que el patrón *sibling containers* (vía socket del host) funcione sin tener que alinear paths del host: un volumen nombrado se resuelve igual para cualquier contenedor que lo monte, a diferencia de un bind mount a una ruta del host.
- Hoy el único runner implementado de extremo a extremo es el análisis estático (Semgrep + Gitleaks, sección 5.4); la ejecución de lint/tests del propio repo del cliente (`node:20-alpine`, `php:8-cli`, etc. según el framework detectado) usa la misma `SandboxRunnerService` pero el *step* que detecta el framework y arma el comando correcto es el siguiente punto a implementar, no algo ya construido.
- Red deshabilitada por defecto; los pasos deterministas que sí necesitan red (p. ej. `semgrep --config=auto` descargando reglas, o un futuro `npm install`) la habilitan explícitamente por parámetro — la ejecución del código bajo prueba en sí nunca la tiene.
- **Trade-off de seguridad aceptado y explícito para esta fase:** montar el socket de Docker le da al `worker` control efectivamente equivalente a root sobre el daemon del host. Es aceptable mientras los clientes sean piloto conocidos y no haya señalización de código arbitrario sin revisar entrando al sandbox. **No es aceptable** en cuanto se abra registro público de organizaciones — en ese punto, V1 ya debe haber migrado a K8s Jobs + gVisor/Kata ([05](05-seguridad-multitenancy-escalabilidad.md#3-ejecución-segura-de-código-sandboxing)), que es la mitigación ya planeada, no una idea nueva.

## 7. Estructura de carpetas del MVP

Subconjunto real del monorepo descrito en [06](06-estructura-carpetas.md), ya implementado y validado (sección 11) — el resto de `apps/*` listadas en ese documento son destino de V1/V2, no placeholders a crear hoy. Monorepo gestionado con **npm workspaces** (no Nx todavía — innecesario con 3 apps y 4 libs; se introduce si el monorepo crece):

```
devsentinel/
├── apps/
│   ├── api/                       # NestJS con HTTP - corre migraciones al boot
│   │   └── src/
│   │       ├── common/            # JwtAuthGuard, CurrentOrg decorator
│   │       └── modules/{auth,github-webhooks,dashboard}/
│   ├── worker/                    # NestJS standalone (sin HTTP) - consumer de BullMQ
│   │   └── src/modules/review/    # repoCheckout, staticAnalysis, sandboxRunner, ragContext,
│   │                              # review.service (orquestador), review.processor, tokens
│   └── web/                       # Next.js App Router - dashboard de solo lectura
│       └── app/{page.tsx, repositories/[id]/page.tsx}
├── libs/
│   ├── shared/
│   │   ├── database/              # migrations/*.sql, migrate.ts, pool.ts, withTenant.ts
│   │   └── event-contracts/       # REVIEW_QUEUE_NAME, ReviewJobPayload
│   └── domain/
│       ├── git-providers/         # GitProviderPort + GithubAdapter (único adapter hoy)
│       └── llm-port/               # LlmPort + OpenAiCompatibleLlmAdapter + embeddings locales
├── infra/
│   ├── caddy/Caddyfile
│   └── postgres/init/01-app-role.sh   # crea devsentinel_app al inicializar el volumen
├── docs/architecture/
├── docker-compose.yml
└── .env.example
```

## 8. Variables de entorno mínimas

Ver [.env.example](../../.env.example) en la raíz del repo — incluye credenciales de Postgres (rol admin y rol de aplicación, ver sección 10), Redis, GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID/SECRET`, `GITHUB_APP_SLUG`), proveedor del LLM (`LLM_PROVIDER_BASE_URL`, `LLM_PROVIDER_API_KEY`, `LLM_MODEL`), `JWT_SECRET` y `PUBLIC_DOMAIN`/`PUBLIC_WEB_ORIGIN`/`API_INTERNAL_URL` (routing y HTTPS automático de Caddy).

## 9. Qué NO incluye este MVP

GitLab/Bitbucket, generación automática de tests, arquitecto virtual (análisis de repo completo), flujos de aprobación multi-paso, SAST/SCA completos (solo Gitleaks), Kubernetes, GPU propia, Keycloak/SSO, bus de eventos distinto a BullMQ, fan-out de sub-agentes. Todo esto es V1+ según [07 - Roadmap](07-roadmap.md#fase-1--v1-meses-5-7) — no es que falte, es que está deliberadamente fuera de esta fase.

## 10. RLS con dos roles de Postgres (detalle de implementación crítico)

Con un solo rol de Postgres, **Row-Level Security no protege nada**: el dueño de las tablas bypassea sus propias políticas por defecto, y el rol creado por `POSTGRES_USER` en la imagen oficial es ese dueño. La implementación real usa **dos roles**:

- `devsentinel` (admin): dueño de las tablas, el único que ejecuta migraciones (`MIGRATIONS_DATABASE_URL`). Creado por la imagen de Postgres vía `POSTGRES_USER`/`POSTGRES_PASSWORD`.
- `devsentinel_app` (aplicación): sin privilegios de owner ni `BYPASSRLS`, el que de verdad usan `api` y `worker` en runtime (`DATABASE_URL`). Se crea una sola vez al inicializar el volumen de Postgres, vía `infra/postgres/init/01-app-role.sh` (mecanismo nativo de `docker-entrypoint-initdb.d`). Los privilegios sobre las tablas se otorgan en la migración `0006_app_role_grants.sql`, incluyendo `ALTER DEFAULT PRIVILEGES` para que las tablas de futuras migraciones (V1+) hereden el grant automáticamente.

El único caso que necesita leer `github_installations` **antes** de conocer el tenant (resolver qué organización corresponde a un `installation_id` que llega en un webhook) se resuelve con una función `SECURITY DEFINER` (`resolve_organization_for_installation`, también en la migración 0006) — expone esa única consulta puntual sin otorgar un bypass general de RLS a `devsentinel_app`.

Esto se verificó empíricamente (no solo por inspección): conectando como `devsentinel_app` sin `app.current_org_id`, una organización ajena devuelve 0 filas; con el `org_id` correcto, devuelve las filas esperadas.

## 11. Validación realizada sobre esta implementación

- `npm install` limpio en el monorepo completo y `tsc`/`nest build` sin errores en los 4 libs y los 2 servicios backend.
- Build de las 3 imágenes Docker (`api`, `worker`, `web`) exitoso.
- Stack completo (`postgres`, `redis`, `api`, `worker`, `web`, `caddy`) arrancado con `docker compose up`: las 6 migraciones se aplican automáticamente al iniciar `api`, el `worker` se conecta a la cola sin errores, `web` renderiza el estado "sin sesión" correctamente llamando a `api` server-side.
- Aislamiento RLS verificado con datos reales (ver sección 10).
- Corregidos dos bugs reales encontrados en esta validación: `@xenova/transformers` (embeddings) no cargaba en Alpine por incompatibilidad musl/glibc con `onnxruntime-node` (el `worker` pasó a `node:20-slim`); el servidor standalone de Next.js no escuchaba en `0.0.0.0` sin `ENV HOSTNAME=0.0.0.0` explícito.
- **No verificado aún** (requiere credenciales reales): el flujo completo de un push/PR real de GitHub, una llamada real al proveedor de inferencia, y la ejecución de Semgrep/Gitleaks contra un repositorio real.
