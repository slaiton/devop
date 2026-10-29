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
   `arn:aws:bedrock:<región>:<cuenta>:inference-profile/global.openai.gpt-5.6-sol` (y el perfil `us.…` si lo usas) **y** sobre
   `arn:aws:bedrock:<región>:<cuenta>:project/default`. En Sol, un perfil global enruta a cualquier región; `us.…` se queda en EE. UU.
3. Bedrock → API keys → crear una clave **de larga duración con vencimiento** para esa identidad.
4. Service Quotas: revisar los tokens por minuto de Sol (cada token de salida consume 10) y crear una alerta en AWS Budgets.

**En DevSentinel**: URL `https://bedrock-runtime.<región>.amazonaws.com/openai/v1`, modelo `global.openai.gpt-5.6-sol`
(o `us.openai.gpt-5.6-sol`) y la clave (se guarda cifrada). El botón *Probar* confirma la conexión. Para comprobar de antemano qué
acepta el modelo en tu cuenta (salida estructurada, herramientas, tokens de uso) hay una sonda:
`node apps/worker/test/bedrock-probe.js` (ver su encabezado).

Los agentes son globales: si Sol es el único agente activo, **todos** los repos se analizan con Sol (unos 4 USD por millón de tokens
de entrada y 20 USD por millón de salida). El agente Bedrock no envía `temperature` ni `response_format: json_object`.

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
