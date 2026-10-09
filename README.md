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
- **Cualquier proveedor de LLM compatible con OpenAI** — DeepSeek, Together.ai, o el que
  prefieras; cambiar de modelo es una fila de configuración, no un redeploy.
- **Quality gate determinista** — reglas duras (secretos, seguridad, arquitectura,
  regresiones) bloquean sin importar lo que opine el modelo; el LLM explica y
  recomienda, no decide solo sobre lo crítico.
- **Análisis estático + contexto recuperado del repo** — hallazgos de Semgrep/Gitleaks
  y fragmentos relevantes del código existente se le entregan al LLM como evidencia,
  no como una caja negra.
- **Pull Requests y merges automáticos** — crea el PR de promoción (rama origen →
  destino) cuando un push sale bien, y puede mergearlo solo cuando el score da verde —
  cada comportamiento se activa por repo, no es una regla global.
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
  disponible como segunda opción. Sesiones cortas (4h), bloqueo por intentos fallidos,
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

### 5. Configurar el LLM y el correo

Ya logueado, en `/settings`: el proveedor de LLM (base URL, modelo, API key) y el SMTP
(sirve cualquier cuenta de correo; es lo que envía la verificación de correo, la
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

### 7. Entrar con passkey

Desde `/me` ("Mi perfil") cada persona agrega su passkey (conviene registrar al menos dos:
computador y teléfono). Desde ahí la pantalla de inicio de sesión ofrece "Entrar con
passkey". Las contraseñas que fija un admin son temporales: la persona debe cambiarlas
en su primer ingreso. Podés invitar más gente desde `/users` y configurar cada repo desde
su pestaña de Configuración.
