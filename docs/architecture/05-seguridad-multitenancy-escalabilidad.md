# 05 — Seguridad, multi-tenancy y escalabilidad

La plataforma maneja código fuente privado de terceros, credenciales de acceso a sus repositorios, y **ejecuta código** (tests generados por IA, tests del propio cliente) — el perímetro de seguridad es más sensible que el de un SaaS típico. Esto condiciona varias decisiones de este documento.

## 1. Autenticación y autorización

### 1.1 Usuarios del dashboard
- **OIDC vía Keycloak** (self-hosted): permite SSO empresarial (SAML/OIDC con el IdP del cliente) sin depender de un IdP de terceros, y soporta SCIM para provisión automática de usuarios en el tier Enterprise.
- Login social (GitHub/GitLab/Bitbucket OAuth) como atajo en MVP/V1 para reducir friction de onboarding, federado igualmente a través de Keycloak.

### 1.2 Acceso a los repositorios del cliente
- **GitHub/GitLab Apps y Bitbucket Connect Apps** en vez de Personal Access Tokens: permisos de grano fino por repo (no "todo el acceso del usuario"), tokens de instalación de corta duración que se renuevan automáticamente, y revocación instantánea desde el lado del proveedor si el cliente desinstala la app.
- Los tokens de instalación se cifran en reposo (envelope encryption vía KMS/Vault) y solo el **Identity & Tenant Service** y el **Git Integration Service** tienen permiso de descifrarlos — ningún otro servicio los toca directamente.

### 1.3 Servicio a servicio
- **mTLS** entre servicios dentro del clúster (Istio/Linkerd como service mesh, introducido en V2/Enterprise; en MVP/V1, JWT de servicio de corta duración firmado por el Identity Service basta).
- Cada servicio valida que el `organization_id` del token coincide con el recurso solicitado — defensa en profundidad además de RLS en base de datos.

### 1.4 RBAC
Roles base: `owner`, `admin`, `developer`, `viewer`, ampliable con roles custom en Enterprise. Las acciones sensibles (cambiar `QualityGateConfig`, aprobar despliegue a producción, revocar conexión Git) requieren `admin`/`owner` y quedan en `AuditLog`.

## 2. Aislamiento multi-tenant

| Tier | Estrategia de datos | Justificación |
|---|---|---|
| Free/Pro | Base de datos compartida, **Row-Level Security** por `organization_id` en cada tabla | Costo operativo bajo, suficiente aislamiento lógico para la mayoría de clientes |
| Business | Esquema dedicado dentro del mismo clúster Postgres | Aislamiento más fuerte sin el costo de infraestructura dedicada completa |
| Enterprise | Base de datos dedicada (incluso clúster K8s dedicado / *single-tenant deployment* si el contrato lo exige) | Requisitos de compliance, residencia de datos o aislamiento físico contractual |

RLS se activa **siempre**, incluso en tiers con esquema/DB dedicada — es la red de seguridad ante bugs de aplicación, no solo una medida de eficiencia.

## 3. Ejecución segura de código (sandboxing)

Este es el riesgo técnico más alto del sistema: el Test Execution Service corre **código potencialmente arbitrario** (tests generados por IA, código de tests del propio repo del cliente, en el futuro posibles refactors auto-aplicados).

- Cada ejecución corre en un **K8s Job de un solo uso**, con runtime aislado (**gVisor** o **Kata Containers**, no `runc` plano) — aislamiento a nivel de kernel, no solo de contenedor.
- **Sin acceso a red por defecto**; si un test necesita red (p. ej. para un mock server interno), se permite solo *allowlist* explícita, nunca egress abierto a internet.
- Límites estrictos de CPU/memoria/tiempo de ejecución (timeout agresivo, p. ej. 2-5 min) con *kill* forzado.
- El filesystem del Job es efímero y de solo el código bajo prueba — nunca monta credenciales ni acceso a otros tenants.
- Resultados (stdout/stderr/cobertura) se capturan y el Job se destruye inmediatamente después — no hay persistencia de estado entre ejecuciones.

## 4. Gestión de secretos

- Tokens de proveedores Git, credenciales de bases de datos, claves de API de LLM: **Vault (HashiCorp)** o el KMS nativo del cloud, nunca variables de entorno planas en manifiestos de Kubernetes.
- Rotación automática de credenciales de servicio; tokens de instalación de Git Apps se renuevan antes de expirar sin intervención manual.
- El propio **Security Scanning Service** (Gitleaks) escanea también el código y configuración de la plataforma misma como parte de su propio pipeline (dogfooding).

## 5. Escalabilidad

- **Servicios stateless** detrás de HPA (Horizontal Pod Autoscaler) escalando por CPU/latencia de cola.
- **Backpressure vía colas:** si el volumen de webhooks o revisiones supera la capacidad de procesamiento, los eventos se acumulan en la cola (con *dead-letter* tras N reintentos) en vez de degradar servicios síncronos — el cliente nunca ve un timeout, en el peor caso ve una revisión que tarda más.
- **Lecturas separadas de escrituras:** réplicas de lectura de PostgreSQL para las consultas pesadas del dashboard/analytics, dejando el primario libre para los flujos transaccionales.
- **Cache:** Redis para resultados de queries frecuentes del dashboard (estado agregado de proyectos) con invalidación dirigida por evento, no TTL ciego.
- **Aislamiento de carga ruidosa:** los *runners* de ejecución de tests/pipelines (la carga más variable e intensiva en CPU) viven en un *node pool* de Kubernetes separado del resto de los servicios, con sus propios límites — un repo con una suite de tests pesada no debe degradar la API del dashboard de otros tenants.
- **Multi-región** (Enterprise): los datos de cada organización pueden anclarse a una región específica (residencia de datos), con el bus de eventos y el gateway desplegados por región.

## 6. Compliance y auditoría (orientado a Enterprise)

- `AuditLog` (ver [02](02-modelo-de-datos.md)) es de solo apéndice e inmutable — base para reportes SOC2/ISO27001.
- Retención configurable de logs/reportes por organización (algunos clientes Enterprise exigen 1-7 años; otros exigen *borrado* a los 90 días — ambos deben ser configurables, no hardcoded).
- Capacidad de **despliegue on-prem / air-gapped** para organizaciones que no pueden enviar código fuera de su red — implica que el `LlmPort` (ver [04](04-agente-ia-arquitecto.md#9-selección-y-enrutamiento-de-modelos)) debe poder apuntar a un modelo desplegado dentro del perímetro del cliente.
- Exportación de datos del tenant (derecho de portabilidad) y borrado completo verificable (derecho al olvido) como operaciones soportadas desde el día uno del modelo de datos, no añadidas después.

## 7. Modelo de amenazas (resumen de los riesgos más críticos)

| Amenaza | Mitigación principal |
|---|---|
| Fuga de código fuente de un tenant a otro | RLS + aislamiento por tier + tests de penetración multi-tenant en CI de la propia plataforma |
| Código malicioso ejecutado durante test generation escapa del sandbox | gVisor/Kata + sin red + límites de recursos + Jobs efímeros de un solo uso |
| Token de instalación Git robado/filtrado | Cifrado en KMS/Vault, scope mínimo por GitHub/GitLab App, rotación y revocación inmediata |
| Prompt injection vía contenido de un PR/comentario malicioso dirigido al LLM | Los hallazgos del LLM nunca ejecutan acciones directamente (solo producen JSON estructurado validado contra esquema); las decisiones de bloqueo pasan siempre por el motor de reglas determinista, no por instrucciones libres devueltas por el modelo |
| Secret scanning con falsos negativos | Múltiples motores (Gitleaks + reglas custom) + bloqueo conservador (cualquier hit de alta confianza bloquea, nunca se "promedia" con otros checks) |
