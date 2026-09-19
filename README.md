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
- **Login validado, no autoservicio** — iniciar sesión con GitHub exige que el correo
  ya esté registrado por un admin; sesiones cortas (4h) que exigen re-validar con
  GitHub al expirar.
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
definen por variable de entorno — GitHub App, LLM y SMTP se configuran después, desde
la UI (`/setup`), cifrados en la base de datos:

```bash
cp .env.example .env
```

Como mínimo hace falta:

- `POSTGRES_PASSWORD` / `APP_DB_PASSWORD` (y sus `DATABASE_URL` / `MIGRATIONS_DATABASE_URL` correspondientes).
- `JWT_SECRET` — firma las sesiones; no lo cambies después sin necesidad.
- `CONFIG_ENCRYPTION_KEY` — genera con `openssl rand -hex 32`, cifra los secretos guardados en `/setup`.
- `GITHUB_OAUTH_CALLBACK_URL` — `https://tu-dominio/api/auth/github/callback`.
- `PUBLIC_DOMAIN` y `PUBLIC_WEB_ORIGIN` — tu dominio público.

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
hay un paso manual aparte.

### 4. Crear la GitHub App

En GitHub (`Settings → Developer settings → GitHub Apps → New GitHub App`):

- **Callback URL:** `https://tu-dominio/api/auth/github/callback`
- **Webhook URL:** `https://tu-dominio/api/webhooks/github`
- **Permisos de repositorio:** `Contents: Read`, `Pull requests: Read & Write`,
  `Checks: Read & Write`, `Issues: Read & Write`, `Metadata: Read`.
- **Eventos de webhook:** `push`, `pull_request`, `installation`,
  `installation_repositories`, `issues`, `issue_comment`.
- Activá **"Request user authorization (OAuth) during installation"** y **"Sign in with GitHub App"** — es el mismo App el que instala y el que autentica, no hace falta una OAuth App aparte.

Guardá el App ID, el slug, el Client ID/Secret, la private key (PEM) y el webhook
secret — se piden en el paso siguiente.

### 5. Registrar la organización, el primer admin y las credenciales

Entrá a `https://tu-dominio/setup`. Hay dos formularios en ese orden — el segundo te
saca de la pantalla apenas lo guardás, así que completá primero el de organización:

1. **Organización y primer admin** — la cuenta/organización de GitHub donde vas a
   instalar la App (debe coincidir exactamente) y el correo del primer admin.
2. **GitHub App / LLM / SMTP** — las credenciales del paso 4, más el proveedor de LLM
   (base URL, modelo, API key) y, opcionalmente, SMTP para las notificaciones por
   correo.

### 6. Instalar la App y entrar

Instalá la GitHub App en la cuenta/organización que registraste, e iniciá sesión desde
`https://tu-dominio` con esa misma cuenta de GitHub (el correo debe coincidir con el
que registraste como admin). Desde ahí ya podés invitar más gente desde `/users` y
configurar cada repo desde su pestaña de Configuración.
