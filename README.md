# DevSentinel AI

**Revisión de código con IA y gestión de Git sin fricción, directo desde tus repos de GitHub.**

DevSentinel AI se instala como una GitHub App y analiza cada push y cada Pull Request
con un LLM configurable, aplica un quality gate determinista, y automatiza todo lo que
hoy hacés a mano entre commit y merge: comentarios de revisión, checks, Pull Requests
de promoción, Issues de seguimiento y notificaciones — todo desde un dashboard propio,
sin perder tiempo saltando entre pestañas de GitHub.

## Funciones principales

- **Revisión de código con IA en cada push y PR** — analiza el diff completo contra el
  contexto real del proyecto (lenguaje, framework, reglas obligatorias, convenciones,
  historial de commits recientes) y devuelve un veredicto (`APTO` / `REQUIERE REVISIÓN`
  / `NO APTO`) con hallazgos categorizados, severidad y sugerencia de arreglo.
- **Varios agentes de IA, en el orden que decidas** — OpenAI, DeepSeek, Grok (xAI) o cualquier
  proveedor compatible con la API de OpenAI. Se configuran en `/settings` y se usan como
  respaldo (si el primero falla pasa al siguiente) o intercalados por turnos; cambiar de
  modelo u orden no requiere redeploy.
- **Quality gate determinista** — reglas duras (secretos, seguridad, arquitectura,
  regresiones) bloquean sin importar lo que opine el modelo; el LLM explica y
  recomienda, no decide solo sobre lo crítico.
- **Análisis estático + contexto recuperado del repo** — hallazgos de Semgrep/Gitleaks
  y fragmentos relevantes del código existente se le entregan al LLM como evidencia,
  no como una caja negra.
- **Pull Requests y merges automáticos** — crea el PR de promoción (rama origen →
  destino) cuando un push sale bien, y puede mergearlo solo cuando el score da verde —
  cada comportamiento se activa por repo, no es una regla global.
- **Merge rápido con ventana de confirmación** — al crear el Pull Request aparece ahí mismo
  "Crear y mergear" / "Mergear ahora". Antes de mergear se revisa en GitHub que sea posible
  (checks, conflictos, ramas protegidas) y se muestra un resumen para confirmar.
- **La IA pregunta antes de bloquear** — cuando una duda depende de algo que no ve (¿se actualizó
  también el otro repo?), el hallazgo queda como pregunta que **no bloquea**: el desarrollador responde
  desde la plataforma o desde GitHub y la IA lo vuelve a evaluar, incluso leyendo el otro repo.
- **Aviso en vivo con sonido** — cuando termina el análisis de un commit suena una campanita en el
  navegador; el admin asigna un tono distinto a cada desarrollador (el dev oye el suyo; el admin, el de todos).
- **Notificación automática al autor** — cada push analizado le avisa por correo a
  quien lo hizo, con el resultado, los hallazgos y la confirmación de auto-merge cuando
  aplica.
- **Issues de GitHub que se gestionan solos** — se crea/actualiza/cierra un Issue con
  los hallazgos bloqueantes vigentes de cada PR o rama, documentando qué commit lo
  originó y cuál lo resolvió; todo el repo se sincroniza (no solo lo que crea la app),
  y hay sugerencias de respuesta generadas por IA para los hilos de comentarios.
- **Reconsideración con evidencia** — un comentario humano ("ya lo corregí", "es un
  falso positivo") dispara una reevaluación del LLM contra el diff real, no una
  aprobación ciega.
- **Roles y permisos reales** — admin ve todo; un usuario solo ve los repos que tiene
  asignados y todos los commits de esos repos, con un CRUD para gestionar personas,
  roles y accesos sin tocar la base de datos.
- **Passkeys y contraseña** — entrás con huella, rostro o el PIN de tu dispositivo
  (WebAuthn, sin contraseña que filtrar ni phishing posible); la contraseña sigue
  disponible como segunda opción. Sesión de 12 h que se renueva mientras usás la app (tope de 7 días),
  bloqueo por intentos fallidos,
  correos verificados, avisos de seguridad y recuperación de cuenta. Nunca se guarda
  ningún dato biométrico: solo la clave pública de cada passkey.
- **Varias GitHub Apps por organización** — cada App con sus propias credenciales,
  instalaciones y webhook, gestionadas desde `/accounts` (con diagnóstico del webhook
  incluido), sin tocar archivos de configuración.
- **Multi-tenant de verdad** — aislamiento por organización con Row-Level Security en
  Postgres, no un filtro `WHERE` que alguien puede olvidar.
- **Dashboard con todo a mano** — pestañas por repo (pushes paginados, Pull Requests,
  Issues, perfil del proyecto, configuración) para no scrollear una página gigante.

## Despliegue

### Requisitos

- Un servidor con Docker y Docker Compose.
- Un dominio apuntando a ese servidor (Caddy emite HTTPS automático vía Let's Encrypt).
- Una cuenta de GitHub (personal o de organización) donde instalar la App.
- Acceso a un proveedor de inferencia compatible con OpenAI (API key).

### 1. Clonar el repo en el servidor

```bash
git clone <url-de-tu-fork> devsentinel
cd devsentinel
```

### 2. Configurar variables de entorno

Copiá `.env.example` a `.env` y completá los valores. Estas son las únicas que se
definen por variable de entorno — las GitHub Apps, el LLM y el SMTP se configuran después
desde la UI, cifrados en la base de datos:

```bash
cp .env.example .env
```

Como mínimo hace falta:

- `POSTGRES_PASSWORD` / `APP_DB_PASSWORD` (y sus `DATABASE_URL` / `MIGRATIONS_DATABASE_URL` correspondientes).
- `JWT_SECRET` — firma las sesiones; no lo cambies después sin necesidad (cierra todas las sesiones).
- `CONFIG_ENCRYPTION_KEY` — genera con `openssl rand -hex 32`, cifra los secretos guardados desde la UI.
- `PUBLIC_DOMAIN` y `PUBLIC_WEB_ORIGIN` — tu dominio público (`https://…`). Las passkeys quedan atadas a
  ese dominio: no lo cambies después de que la gente registre las suyas.

### 3. Levantar los servicios

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

o usá el script incluido, que además valida que las variables requeridas estén
definidas y espera a que cada servicio quede sano antes de seguir con el siguiente:

```bash
./infra/scripts/deploy.sh
```

Las migraciones de base de datos corren solas al arrancar el contenedor `api` — no
hay un paso manual aparte. Las imágenes usan Node 22.

### 4. Registrar la organización y el primer admin

Entrá a `https://tu-dominio/setup`: elegí el identificador de la organización y el
correo y la contraseña del primer admin. Con eso ya podés iniciar sesión.

### 5. Configurar los agentes de IA y el correo

Ya logueado, en `/settings`:

- **Agentes de IA:** agrega uno o varios (OpenAI, DeepSeek, Grok u otro compatible con la API
  de OpenAI; cada preset rellena la URL y sugiere modelos) con su API key, que se guarda
  cifrada. El botón **Probar** verifica URL, modelo y clave antes de usarlo. El orden de la
  lista es el orden de uso, con dos modos:
  - **Respaldo:** siempre el primero; si falla (caído, sin saldo, límite de uso) el análisis
    pasa solo al siguiente. Un agente que falla queda en pausa 2 minutos para no
    reintentarlo en cada commit.
  - **Intercalar:** cada análisis lo hace el siguiente agente activo, por turnos (reparte
    costo y límites); si el que toca falla, sigue el siguiente de la rotación.

  Cada commit muestra qué agente lo analizó y, si hubo que pasar a otro, cuál falló y por qué.
  En el análisis profundo, un agente que no soporta herramientas se salta y lo hace el
  siguiente; si ninguno las soporta, el commit se analiza en modo estándar. Los modelos de
  razonamiento de OpenAI (o…, gpt-5…) se llaman sin el parámetro `temperature`. Si ya tenías un
  proveedor configurado, pasa solo a ser el agente #1.
- **SMTP** (sirve cualquier cuenta de correo; es lo que envía la verificación de correo, la
  recuperación de contraseña y las notificaciones a los autores de cada push).

### 6. Crear y conectar una GitHub App

En GitHub (`Settings → Developer settings → GitHub Apps → New GitHub App`):

- **Webhook URL:** `https://tu-dominio/api/webhooks/github` (la misma para todas las Apps).
- **Setup URL:** `https://tu-dominio/api/github-apps/callback`, con **"Redirect on update"** activado.
- **Permisos de repositorio:** `Contents: Read`, `Pull requests: Read & Write`,
  `Checks: Read & Write`, `Issues: Read & Write`, `Metadata: Read`.
- **Eventos de webhook:** `push`, `pull_request`, `issues`, `issue_comment`.

Después, en `/accounts`: **Agregar GitHub App** (App ID, slug, Client ID/Secret, private
key PEM y webhook secret) y **Conectar una cuenta nueva** — o **Sincronizar instalaciones
existentes** si la App ya estaba instalada. Si una App no recibe pushes, **Diagnosticar
webhook** te dice por qué (URL, eventos sin suscribir, secret que no coincide) y puede
corregir la URL y el secret en GitHub y reenviar las entregas fallidas.

Cada repositorio muestra, junto a su nombre (lista de repos y cabecera del repo), si está
**apto para recibir pushes** o qué le falta: credenciales de la App, URL del webhook, eventos
`push`/`pull_request` suscritos, permisos **aceptados por la cuenta** (si cambias los permisos
de una App, el dueño de la cuenta debe aprobarlos en la instalación o GitHub no manda los
eventos), repo incluido en la instalación, pushes ya recibidos y contexto del proyecto.
`/webhooks` es el registro de todo lo que GitHub entrega, con el motivo de cada descarte.
En la pestaña **Perfil del proyecto**, **Generar contexto** lee el README, CLAUDE.md /
AGENTS.md, los archivos de dependencias y la estructura de carpetas de la rama principal y
arma el perfil con la IA (si ya lo configuraste a mano, solo completa los campos vacíos).
`GITHUB_API_URL` y `GITHUB_GIT_URL` (opcionales) apuntan la API y los clones a otro servidor
compatible, p. ej. GitHub Enterprise Server.

### Amazon Bedrock (GPT-5.6 Sol)

Bedrock se agrega como un agente más en `/settings` → **Agregar Amazon Bedrock**. Usa la API compatible con
OpenAI de `bedrock-runtime` con una **clave API de Bedrock**; no necesita variables de entorno ni cambios de infraestructura.

**En AWS**
1. Consola de Bedrock → habilitar el acceso a *GPT-5.6 Sol* (puede pedir aceptar los términos de Marketplace).
2. Crear una identidad IAM dedicada (usuario) con permiso `bedrock:InvokeModel` **solo** sobre
   `arn:aws:bedrock:<región>:<cuenta>:inference-profile/us.openai.gpt-5.6-sol` y `…/us.openai.gpt-5.6-luna` (los perfiles `global.…` enrutan a
   cualquier región; `us.…` se queda en EE. UU.) **y** sobre `arn:aws:bedrock:<región>:<cuenta>:project/default`.
3. Bedrock → API keys → crear una clave **de larga duración con vencimiento** para esa identidad.
4. Service Quotas: revisar los tokens por minuto de Sol (cada token de salida consume 10) y crear una alerta en AWS Budgets.

**En DevSentinel**: URL `https://bedrock-runtime.<región>.amazonaws.com/openai/v1`, modelo `us.openai.gpt-5.6-luna` o
`us.openai.gpt-5.6-sol` (o su versión `global.`) y la clave (se guarda cifrada). El botón *Probar* confirma la conexión. Para comprobar de antemano qué
acepta el modelo en tu cuenta (salida estructurada, herramientas, tokens de uso) hay una sonda:
`node apps/worker/test/bedrock-probe.js` (ver su encabezado).

Los agentes son globales: si Sol es el único agente activo, **todos** los repos se analizan con Sol (unos 4 USD por millón de tokens
de entrada y 20 USD por millón de salida). El agente Bedrock no envía `temperature` ni `response_format: json_object`.

### Auditoría por capas — capa 1: escáneres deterministas

Se activa por repositorio en **Configuración → Auditoría por capas** (apagada por defecto: ningún repo cambia hasta que la actives).
Antes de la IA corren, sin gastar tokens, solo los escáneres que **aplican** a lo que hay en el repo:

| Escáner | Aplica si el repo tiene | Qué busca |
|---|---|---|
| Gitleaks | siempre | secretos y credenciales |
| Semgrep | código fuente de un lenguaje soportado | patrones inseguros y vulnerabilidades |
| Trivy | lockfiles o manifiestos de dependencias | CVE en dependencias |
| Checkov | Terraform, CloudFormation, Kubernetes, Helm o workflows de GitHub Actions | malas configuraciones de IaC |
| Hadolint | Dockerfiles | malas prácticas en imágenes |

- **Versiones controladas**: cada imagen se ejecuta por *digest* (ver `apps/worker/src/modules/audit/scanners.ts`), no por `latest`;
  `AUDIT_IMAGE_<HERRAMIENTA>` la reemplaza (queda registrado). Las reglas de Semgrep (registro) y la base de Trivy cambian con el tiempo:
  se muestran como "no fijadas". Cada ejecución guarda versión, digest, reglas, duración y estado.
- **Aislados**: usuario sin privilegios, sistema de archivos raíz y repo en solo lectura, sin *capabilities*, sin escalada, límites de
  CPU, memoria y tiempo; sin red salvo Semgrep (reglas) y Trivy (su base). Corren desde un directorio vacío, no desde el repo.
- **El repo no puede cambiar las reglas**: sus `.semgrepignore`, `.trivyignore`, `.gitleaks.toml`, `.checkov.yaml`, `.hadolint.yaml`… se
  retiran del checkout y se avisan; `nosemgrep` y `gitleaks:allow` se ignoran. Las directivas `checkov:skip` y `hadolint ignore`, que no
  se pueden desactivar, se cuentan y se muestran.
- **Normalizados y sin duplicados**: un esquema común (herramienta, regla, severidad, archivo, líneas, CVE, evidencia, huella). La huella se
  calcula sobre el contenido, no la línea: reconoce el mismo problema entre commits. Cada hallazgo es **nuevo** (en líneas que el diff
  agrega) o **preexistente**, y **confirmado** o **pendiente de validación**.
- **Sin secretos en ningún lado**: Gitleaks corre con `--redact`; los secretos no llevan evidencia; el resto pasa por una redacción de respaldo.
- **Una herramienta que no corre no es "sin hallazgos"**: si un escáner obligatorio y aplicable falla, no está disponible o se pasa de
  tiempo, la auditoría queda **incompleta** (visible en la página del commit y en el check de GitHub) y **nunca sale APTO**. También se comprueba que el contenedor ve el repo clonado.
- **Política determinista** (solo endurece, nunca afloja): un secreto *nuevo* bloquea (si `block_on_secret`) aunque el modelo diga APTO. Se
  respeta al recalcular tras una aclaración o reconsideración. `review_runs.audit_stage` guarda la etapa de ejecución
  (`running_layer_1` … `completed`/`failed`), separada del resultado.

Opcionales: `AUDIT_SCANNER_CONCURRENCY` (2), `AUDIT_OPTIONAL_SCANNERS=hadolint,checkov` (los que no vuelven incompleta la auditoría si fallan),
`AUDIT_SEMGREP_CONFIGS` (por defecto `p/default,p/owasp-top-ten`), `WORKSPACE_VOLUME`. Herramientas que ejecutan código del repo (PHPStan,
ESLint con plugins, PHPUnit…) **no** están incluidas: requerirían un entorno aislado y un permiso explícito por repo.

Las primeras ejecuciones descargan las imágenes (Semgrep pesa ~1,5 GB); para precargarlas en el servidor:
`docker pull <imagen>@sha256:…` con los digests de `scanners.ts`.

### Auditoría por capas — capa 2 (triaje), modelo por capa y presupuesto

**Modelo por capa.** En **Configuración → Agentes de IA**, cada agente tiene un *rol*: **General** (la revisión de siempre, reconsideraciones,
aclaraciones y respaldo), **Capa 2 · triaje** o **Capa 3 · auditoría avanzada**. Un agente con rol de capa queda fuera de la rotación
general; la capa solo usa sus propios agentes (con respaldo entre ellos) y **nunca cae a un agente general**: si no hay ninguno asignado,
esa capa no corre. Si TODOS los agentes están asignados a capas, las tareas generales usan cualquier agente activo para no dejar de funcionar.
Configuración recomendada: Sol como *General* (también atiende las escaladas) y Luna como *Capa 2*.

**Capa 2** (por repositorio, requiere la capa 1): un modelo barato (p. ej. GPT-5.6 Luna en Bedrock) recibe datos estructurados —no el
repositorio—: el diff con los secretos **redactados**, los hallazgos de los escáneres con su contexto de código (±12 líneas), los usos de los
símbolos que cambian, el perfil del proyecto y el tipo de cambio (auth, iam, ci_cd, migration, payments, infra, dependencies, calculado por la
aplicación). Devuelve un JSON con **esquema estricto** que además se valida en la aplicación. Qué hace con él:
- Agrupa hallazgos, prioriza y puede marcar **falsos positivos** de patrones heurísticos con un motivo. **Nunca** descarta un secreto ni una
  coincidencia determinista confirmada (Gitleaks, Trivy, Checkov, Hadolint): ese intento se ignora, queda registrado y cuenta como conflicto.
- Añade hallazgos que los escáneres no ven (lógica, autorización, validación, transacciones, concurrencia, migraciones…). Cada uno debe
  traer una **cita textual** del código y un archivo/línea reales: la aplicación los busca en el repositorio y **descarta** (con el motivo) los que
  no encuentra. Un hallazgo sin comprobar no puede ser grave (baja a *medium*).
- Si no hay motivo para escalar, **su revisión es la del commit** y no se paga el revisor general. Si falla, no hay agente asignado o no hay
  presupuesto, se revisa con el agente general y la auditoría queda **incompleta** (nunca APTO).
- **Escalamiento a la auditoría avanzada**, por reglas reproducibles y no solo por la opinión del modelo: cambios de autenticación, IAM, CI/CD,
  migraciones o pagos; recomendación del modelo; hallazgo grave confirmado *nuevo*; riesgo alto; o un conflicto con un escáner
  (`AUDIT_ESCALATION_TAGS` cambia los tipos de cambio). La escalada la atiende el agente de la **capa 3** si hay uno asignado, o el revisor
  general (Sol) si no; en ambos casos recibe un **resumen** del triaje y no el código completo (ver *Contexto por capa*).
- Nada de lo que diga puede aprobar o desbloquear: la política determinista de la capa 1 sigue mandando.

**Presupuesto de IA** (Configuración → Presupuesto de IA): tope mensual (50 USD por defecto), tope por auditoría (1 USD) y qué hacer al
agotarlo — *revisión parcial* (la capa se omite, auditoría incompleta, nunca APTO) o *bloquear* (además NO APTO). Antes de cada llamada de
la capa 2 se estima una cota superior de su costo y se compara con lo gastado en el mes y en esa auditoría. Cada llamada a un modelo queda en
`llm_invocations` (tokens, tokens de razonamiento y de caché, latencia, errores; sin prompts) con su costo según la **tarifa vigente de
`model_prices`** — datos editables, no código; los valores iniciales salen de las fichas de modelo de Bedrock (verifícalos contra la página de
precios y agrega una fila cuando cambien; el contexto de más de 272K tokens se cobra a otra tarifa). Un modelo sin tarifa corre igual pero no
se puede contabilizar ni limitar (se avisa). La página de cada commit muestra el consumo por capa y su total. Variables opcionales:
`AUDIT_L2_REASONING` (esfuerzo de razonamiento, `low`), `AUDIT_L2_MAX_OUTPUT_TOKENS` (8000).

### Contexto por capa (que ningún modelo reciba más de lo que cabe)

Un modelo de Bedrock rechaza con `400 Context window exceeded` lo que supere su ventana, y por encima de 272K tokens cobra el doble. En vez de
usar un modelo con más ventana, cada capa recibe **solo lo que necesita**:

| Capa | Qué recibe | Tope de entrada |
|---|---|---|
| 1 · escáneres | no usa IA | — |
| 2 · triaje (Luna) | hallazgos de la capa 1 con su referencia, fragmentos de código de esos hallazgos, usos de símbolos y el diff **dividido en partes** que caben | `AUDIT_L2_MAX_INPUT_TOKENS` (100.000 por llamada) |
| 3 · avanzada (Sol) | resumen ejecutivo del triaje, hallazgos graves con su evidencia, conclusiones y motivos de escalamiento, y el parche **solo** de los archivos con hallazgos graves o de cambio sensible. **Nunca** el código completo si la capa 2 ya lo auditó | `AUDIT_L3_MAX_INPUT_TOKENS` (60.000) |
| revisión general | la entrada completa, ajustada al presupuesto | `LLM_MAX_INPUT_TOKENS` (150.000) |

El tope efectivo es el menor entre el de la capa y la ventana real del agente. Controles:
- **Contador de tokens antes de cada solicitud.** No hay tokenizador propio: se parte de 3 caracteres por token (conservador) y la relación se
  corrige con el consumo real (`prompt_tokens`) que reporta el proveedor. Si lo estimado no cabe, la solicitud **no se envía**.
- **Presupuesto con reserva para la respuesta.** Por agente (Configuración → Agentes de IA → *Ventana de contexto* y *Tokens reservados para la
  respuesta*; vacíos = `LLM_DEFAULT_CONTEXT_TOKENS` 272000 y `LLM_DEFAULT_OUTPUT_TOKENS` 16000): entrada máxima = (ventana − reserva) × 0,92.
- **Fragmentación lógica.** Un archivo gigante se parte por *hunks* (cada parte repite la cabecera del archivo) y un cambio grande por grupos de
  archivos. La capa 2 analiza cada parte por separado (máximo `AUDIT_L2_MAX_CHUNKS`, 4) y **une** los resultados tomando siempre lo más estricto.
- **Compresión entre capas.** La capa 3 recibe el resumen de la 2, no sus entradas; la capa 1 aporta métricas. En el modo profundo, los resultados
  de herramientas más antiguos se resumen antes de que la conversación supere el presupuesto.
- **Relevancia.** Entra primero lo que toca hallazgos graves, luego los cambios sensibles (auth, IAM, CI/CD, migraciones, pagos), luego el código;
  pruebas y documentación al final; lockfiles y generados se resumen en una línea.
- **Reintento inteligente.** Si aun así se rechaza por tamaño, se reintenta con 1/2 y luego 1/4 del presupuesto (nunca la misma solicitud), se
  **aprende el límite real** del modelo y el rechazo no pausa ni marca como caído al agente. Si no alcanza el presupuesto de dinero para todas las
  partes, se hacen las que caben y la revisión queda **parcial**. Lo que no se analizó se dice, y una revisión parcial nunca puede ser APTO.

### Commits muy grandes: límites y rendimiento

**Entrada del modelo.** Un commit enorme (lockfiles, código generado, cientos de archivos) ya no viaja entero al modelo: Bedrock respondía
`400 Your input exceeds the context window of this model` y, además, por encima de 272K tokens de entrada cobra el doble. Antes de cada
revisión la entrada se ajusta a un presupuesto (`LLM_MAX_INPUT_TOKENS`, 150000 por defecto):
- los **lockfiles, archivos generados, minificados, binarios y vendor** se resumen en una línea (los escáneres ya cubren las dependencias);
- el parche de un archivo de código gigante se recorta (30.000 caracteres) y **lo que no cabe se omite entero**, nombrándolo en el prompt;
- se acotan la lista de archivos (300), los hallazgos de analizadores (100), el contexto recuperado y el historial de commits.
Si hubo que dejar código fuera, la revisión es **parcial**: queda en *requiere revisión* (nunca APTO), lo dice la nota del commit y el check de GitHub.
Si el modelo aun así rechaza la entrada por tamaño, se reintenta con la mitad y luego con la cuarta parte del presupuesto. Ese rechazo **no es una
falla del agente**: no lo pausa ni lo marca como caído en Configuración. Un cambio que solo trae lockfiles y generados se resume y puede ser APTO.

**Página del commit.** El resumen y los hallazgos se muestran de inmediato; el diff se carga aparte (Suspense). Por defecto se pintan hasta 60
archivos / 4.000 líneas (los archivos con hallazgos siempre, los lockfiles colapsados); `?diff=all` amplía el límite. La API guarda el diff en
memoria (un commit es inmutable) y lo acota a `DIFF_MAX_CHARS` (2.000.000) sin partir archivos ni recortar los que tienen hallazgos. La pantalla de
preguntas de la IA consulta un estado mínimo cada 3 s y solo recarga la página cuando algo cambia. Con un commit de 5,9 MB: primer contenido de
3,2 s a 0,2 s; diff pintado de 10,8 s a 1,1 s; nodos del DOM de 188.000 a 23.000; recargar ya no vuelve a pedir el diff a GitHub.

### Análisis estándar y profundo

Cada repositorio tiene, en **Configuración**, su **profundidad del análisis**:

- **Estándar** (por defecto): una sola pasada del modelo sobre el diff, el perfil del proyecto,
  los analizadores estáticos y los últimos commits.
- **Profundo**: el revisor investiga antes de opinar, con herramientas de **solo lectura** sobre el
  clon del commit: leer archivos o rangos, buscar usos (`git grep`), listar carpetas, historial y
  `blame` de un archivo, leer commits previos, búsqueda semántica, y —por la API de GitHub— leer
  archivos de otros repos de la misma instalación o de otra rama, y el contexto del Pull Request.
  Antes de empezar recibe, sin gastar tokens, el PR, el historial reciente de cada archivo
  modificado y dónde más se usan los símbolos que el diff agrega. Cada hallazgo debe citar
  `archivo:línea` de lo que verificó.

La investigación está acotada por commit (12 rondas, 40 consultas, ~160 000 caracteres devueltos y
4 minutos); si se agota, el veredicto se da con lo reunido. Si el modelo no acepta herramientas
(function calling) o la investigación falla, el commit se analiza en modo estándar y la página del
commit dice por qué: ningún push se queda sin revisar. Esa página muestra además el modo usado,
rondas, consultas, tokens y la lista de lo que consultó la IA ("Qué revisó la IA antes de opinar").

Las herramientas no pueden leer `.git/` (su configuración puede traer el token), archivos `.env`,
llaves privadas ni los informes del análisis estático, y rechazan rutas fuera del repo (`..`,
symlinks). El resultado que devuelven se trata como datos, no como instrucciones. Requiere un
modelo con function calling compatible con la API de OpenAI (p. ej. `deepseek-chat`, Grok 3/4);
los modelos de razonamiento puro suelen no aceptarlo y caerán al modo estándar.

### Preguntas de la IA antes de bloquear

Si un hallazgo depende de algo que la IA no puede comprobar con lo que ve (p. ej. "cambió el
contrato de la API: ¿se actualizó también el cliente en otro repo?"), no lo marca como bloqueante: lo
registra como **pregunta** (`awaiting_clarification`). Mientras haya preguntas sin resolver el commit
queda como mucho en `REQUIERE REVISIÓN` (nunca `APTO`), pero las preguntas **no** lo vuelven `NO APTO`.

- **Dónde se responde**: en la página del commit ("Preguntas de la IA"), o comentando en el Issue de
  seguimiento o en la conversación del Pull Request de GitHub (la IA menciona al autor con `@usuario`).
  Quien puede responder: un admin, el autor del commit (su cuenta vinculada) o quien tenga el repo asignado.
- **Cómo decide**: relee el hallazgo con la respuesta y, si indicás otro repositorio, lo **verifica en GitHub**
  con herramientas de solo lectura (leer un archivo, buscar código, ver el contexto de un PR), limitadas a
  repos registrados en la misma organización e instalación. Puede **descartarlo** (falso positivo),
  **confirmarlo** (pasa a hallazgo real y bloquea según el veredicto) o **repreguntar**. Máximo 2 rondas:
  si sigue sin poder decidir, queda pendiente de una **persona** y un admin lo confirma o descarta
  desde la misma tarjeta.
- Al resolverse se recalcula el veredicto, se actualiza el check de GitHub y el Issue, y se vuelve a
  avisar (con sonido) del commit.
- Si ningún agente de IA responde, nada se pierde: el trabajo se reintenta y el hallazgo sigue pendiente.

### Avisos en vivo y sonido

Al terminar el análisis de un commit, el navegador recibe el aviso por una conexión SSE
(`/api/notifications/stream`): un mensaje emergente con el veredicto, el score, el repo y el autor, un
tono y —con la pestaña en segundo plano— una notificación del navegador. Un admin recibe los de todos los
desarrolladores; un desarrollador, los de sus commits (su cuenta debe estar vinculada a su perfil de
desarrollador). Un `NO APTO` suena dos veces.

El admin elige el tono, el volumen o el silencio de cada desarrollador en **Developers**; cada persona
puede además apagar el sonido o las notificaciones del navegador desde la campana 🔔 (preferencia por
navegador). Los navegadores solo permiten audio tras un clic en la página: la campana lo avisa.
Variables opcionales de la API: `NOTIFY_POLL_MS` (cada cuánto busca análisis nuevos, 2000) y
`NOTIFY_PING_MS` (latido de la conexión, 25000). Si ponés un proxy propio delante, no debe bufferizar
`text/event-stream`.

### Sesión

La sesión dura 12 h (`SESSION_TTL_HOURS`) y se **renueva sola mientras usás la app**, con un tope
absoluto de 7 días (`SESSION_ABSOLUTE_MAX_DAYS`). Diez minutos antes de vencer sin actividad aparece un
aviso. Renovar no cuenta como volver a autenticarse: las acciones sensibles siguen pidiendo
re-autenticación reciente.

### 7. Entrar con passkey

Desde `/me` ("Mi perfil") cada persona agrega su passkey (conviene registrar al menos dos:
computador y teléfono). Desde ahí la pantalla de inicio de sesión ofrece "Entrar con
passkey". Las contraseñas que fija un admin son temporales: la persona debe cambiarlas
en su primer ingreso. Podés invitar más gente desde `/users` y configurar cada repo desde
su pestaña de Configuración.
