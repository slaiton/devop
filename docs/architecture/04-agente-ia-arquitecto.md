# 04 — Agente de IA / Arquitecto virtual

Este documento detalla el componente más diferenciador de la plataforma: el agente que revisa código, razona sobre arquitectura y genera tests. No es "un prompt grande" — es un sistema con orquestación, recuperación de contexto, herramientas y *guardrails* deterministas.

## 1. Principio rector: determinista bloquea, probabilístico explica

Un LLM es probabilístico por naturaleza: puede alucinar, pasar por alto un caso, o variar su respuesta entre corridas. Por eso la plataforma separa dos capas con responsabilidades distintas:

| Capa | Responsable de | Ejemplos |
|---|---|---|
| **Motor de reglas deterministas** | Decisiones de **bloqueo** binario, auditable y reproducible | Secreto expuesto detectado por Gitleaks → bloqueo automático, sin excepción. CVE crítico sin parche → bloqueo. Cobertura < umbral configurado → bloqueo. |
| **LLM (orquestador + sub-agentes)** | **Explicar, contextualizar, priorizar y sugerir** | "Este método tiene 14 responsabilidades distintas, viola SRP; te propongo extraer estas 3 clases" — razonamiento, no un simple if/else. |

El LLM puede **proponer** que algo se bloquee (p. ej. "este patrón es tan arriesgado que recomiendo riesgo alto"), pero las condiciones de bloqueo *configuradas por la organización* (`QualityGateConfig`) siempre se evalúan con lógica determinista sobre los datos estructurados que produce el LLM — nunca parseando lenguaje natural en el camino crítico de bloqueo.

## 2. Arquitectura interna: orquestador + sub-agentes

```
                    ┌─────────────────────────────┐
                    │   Review Orchestrator        │
                    │  (recibe diff + metadata)     │
                    └───────────────┬───────────────┘
                                     │ fan-out paralelo
        ┌──────────────┬────────────┼────────────┬──────────────┐
        ▼              ▼            ▼            ▼              ▼
   ┌─────────┐   ┌───────────┐ ┌─────────┐ ┌───────────┐ ┌──────────────┐
   │ Clean   │   │ Security  │ │ Arch. & │ │Performance│ │ Docs &       │
   │ Code /  │   │ Reviewer  │ │ SOLID   │ │ Reviewer  │ │ Best         │
   │ Duplic. │   │ Sub-agent │ │ Sub-    │ │ Sub-agent │ │ Practices    │
   │Sub-agent│   │           │ │ agent   │ │           │ │ Sub-agent    │
   └────┬────┘   └─────┬─────┘ └────┬────┘ └─────┬─────┘ └──────┬───────┘
        └──────────────┴────────────┴────────────┴──────────────┘
                                     │ fan-in
                          ┌──────────▼──────────┐
                          │   Synthesis & Score   │  → Finding[] + quality_score + risk_level
                          │   (dedup, priorizar)  │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Guardrails          │  → aplica reglas deterministas
                          │  deterministas        │     sobre los Finding[] estructurados
                          └──────────────────────┘
```

**Por qué sub-agentes especializados y no un único prompt:**
- Cada sub-agente tiene un *system prompt* enfocado (p. ej. el de seguridad conoce OWASP Top 10, el de arquitectura conoce SOLID y patrones GoF) — mejora precisión vs. un prompt genérico que intenta cubrir todo.
- Se ejecutan **en paralelo**, acotando la latencia total a la del sub-agente más lento, no a la suma.
- Permite **evaluar y mejorar cada uno por separado** (precisión/recall por categoría) y, a futuro, usar modelos distintos por tarea (p. ej. un modelo más barato para docs, uno de razonamiento más profundo para arquitectura).
- El framework de orquestación es el **Claude Agent SDK**: cada sub-agente es un agente con su propio set de herramientas (no todos necesitan las mismas).

## 3. Herramientas (*tool use*) de los sub-agentes

Cada sub-agente opera en bucle agente-herramienta, no en una sola pasada de texto:

| Herramienta | Quién la usa | Qué hace |
|---|---|---|
| `get_file_context(path, symbol?)` | Todos | Recupera archivo completo o símbolo específico, vía RAG (sección 4) |
| `run_static_analyzer(tool, paths)` | Clean Code, Security | Invoca Semgrep/ESLint/PHPStan/etc. y devuelve hallazgos crudos como evidencia adicional |
| `query_dependency_graph(module)` | Arquitectura | Consulta el grafo de dependencias precomputado del repo (detecta ciclos, fan-in/out) |
| `search_similar_code(snippet)` | Clean Code | Búsqueda por similitud de embeddings para detectar duplicación cruzada de archivos |
| `run_sandboxed_test(code)` | Test Generation | Ejecuta un test candidato en sandbox aislado y devuelve pass/fail + cobertura |
| `get_repo_conventions()` | Docs, Test Generation | Heurísticas + ejemplos extraídos del propio repo (estilo de tests, naming, linters configurados) para que las sugerencias respeten las convenciones existentes en vez de imponer un estilo genérico |

Combinar resultados de herramientas deterministas **dentro** del razonamiento del LLM (en vez de solo "LLM lee diff a ciegas") reduce alucinaciones: el modelo cita evidencia concreta (salida de Semgrep, línea exacta del grafo de dependencias) en lugar de inferir todo desde el texto del diff.

## 4. Recuperación de contexto (RAG sobre el código)

Un LLM no puede (ni debe, por costo/latencia) recibir un repositorio completo en cada revisión. Estrategia:

1. **Indexación incremental:** al conectar un repo, se parsea con *tree-sitter* (multi-lenguaje) en *chunks* a nivel de función/clase/módulo. Cada chunk se embebe (modelo de embeddings) y se guarda en `CodeChunkEmbedding` (pgvector en MVP/V1, Qdrant dedicado en V2+).
2. En cada push, solo se **re-indexan los archivos modificados** (diff-aware), no el repo completo — mantiene el índice fresco sin costo lineal por evento.
3. En una revisión, el orquestador recupera: (a) los chunks que el diff modifica directamente, (b) chunks relacionados por *import graph* (quién llama/es llamado por el código cambiado), (c) los top-K chunks más similares semánticamente (para detectar duplicación o convenciones existentes).
4. Este contexto recuperado —no el repo completo— se inyecta en el prompt de cada sub-agente junto con el diff.

Esta misma infraestructura de embeddings + grafo de imports es la que usa el **Virtual Architect Service** (doc 03, Flujo D), pero operando sobre el repo completo en batch en vez de sobre un diff puntual.

## 5. Contrato de salida estructurado

Todo sub-agente devuelve **JSON validado contra esquema** (no markdown libre), para que el resto del sistema (guardrails, dashboard, métricas) pueda procesarlo sin parsear lenguaje natural:

```json
{
  "findings": [
    {
      "category": "solid_violation",
      "subtype": "single_responsibility",
      "severity": "high",
      "file_path": "src/orders/OrderService.ts",
      "line_start": 42,
      "line_end": 210,
      "title": "OrderService mezcla persistencia, notificación y cálculo de impuestos",
      "explanation": "La clase tiene 3 razones de cambio independientes: si cambia el proveedor de notificaciones, el cálculo de impuestos o el ORM, esta clase se modifica en los 3 casos...",
      "evidence": ["fan_out=18", "métodos_públicos=22", "semgrep_rule: god-class-heuristic"],
      "suggested_fix": {
        "type": "extract_class",
        "diff": "--- a/src/orders/OrderService.ts\n+++ ...",
        "new_files": ["src/orders/TaxCalculator.ts", "src/notifications/OrderNotifier.ts"]
      },
      "confidence": 0.86
    }
  ],
  "quality_score": 71,
  "risk_level": "medium",
  "summary": "2 hallazgos de severidad alta relacionados con SOLID, 0 de seguridad, cobertura del diff: 54%."
}
```

El campo `confidence` permite a los **guardrails deterministas** aplicar políticas como "solo auto-bloquear si `confidence >= 0.8` y `severity in (high, critical)`; por debajo, marcar como sugerencia no bloqueante" — configurable por organización.

## 6. Generación automática de tests

1. El sub-agente de Test Generation recibe la función/clase sin cobertura + `get_repo_conventions()` (qué framework, qué estilo de assertions, qué fixtures/mocks ya existen).
2. Genera el test y lo **valida ejecutándolo de inmediato** vía `run_sandboxed_test` antes de proponerlo — nunca se sugiere un test sin haber confirmado que compila y corre.
3. Si el test generado falla contra el código actual de forma inesperada (no es TDD intencional), el sub-agente itera (máximo N intentos) ajustando mocks/imports antes de desistir y marcar el caso como "requiere intervención humana".
4. La sugerencia final incluye **qué casos cubre y por qué se eligieron** (caminos felices, bordes, errores) — no solo el código.

## 7. Detección de problemas arquitectónicos (Virtual Architect)

Técnicas deterministas que alimentan al LLM como evidencia (no reemplazan su razonamiento, lo fundamentan):

| Problema | Técnica determinista | Heurística de umbral inicial (configurable) |
|---|---|---|
| God class / controller gigante | LOC, número de métodos públicos, número de dependencias inyectadas (fan-in del constructor) | >300 LOC o >15 métodos públicos o >7 dependencias |
| Violación SRP/SOLID | Cohesión léxica (LCOM), múltiples *axes of change* detectados por clustering de métodos según qué campos usan | LCOM alto + LLM confirma con explicación semántica |
| Dependencias circulares | DFS sobre el grafo de imports a nivel de módulo | Cualquier ciclo se reporta; severidad escala con el tamaño del ciclo |
| Consultas N+1 | Análisis de AST: llamada a método de ORM dentro de un bucle `for`/`map` sobre una colección obtenida de otra consulta, sin `include`/`join`/`with` previo | Patrón sintáctico + LLM valida que no sea un falso positivo (p. ej. ya usa dataloader) |
| Código muerto | Análisis de alcanzabilidad estático (símbolos exportados nunca importados, funciones nunca llamadas dentro del grafo de llamadas) | Confirmado si no aparece en ningún punto de entrada conocido (rutas, CLI, tests) |
| Duplicación | *Clone detection* vía hashing de AST normalizado (ignora nombres de variables) | Similaridad >85% en bloques >10 líneas |
| Riesgo de escalabilidad | Heurísticas por framework: queries sin paginar, falta de índices en columnas usadas en `WHERE`/`JOIN` (cruzado con el esquema real), llamadas síncronas a servicios externos dentro de loops | Señales combinadas, siempre con explicación del LLM del impacto esperado |

Cada hallazgo de esta tabla se adjunta como **evidencia estructurada** al prompt del sub-agente de arquitectura, que la traduce en una explicación entendible y un `RefactorProposal` concreto (diff propuesto), en vez de generar el diagnóstico desde cero solo con su intuición.

## 8. Comentarios sobre el PR

- Se postean como **comentarios de revisión en línea** usando el API nativo de *review comments* de cada proveedor (no comentarios planos), anclados a `file_path` + `line`.
- Formato: título corto + severidad + explicación técnica del *por qué* + bloque de sugerencia de código cuando aplica (usando `suggestion` blocks de GitHub/GitLab cuando el proveedor lo soporta, para permitir aplicar el fix con un clic).
- Un comentario-resumen único en el PR consolida `quality_score`, `risk_level` y conteo de hallazgos por severidad, con enlace al reporte completo en el dashboard.
- El agente se identifica siempre como bot (`devsentinel-ai[bot]`) — nunca se hace pasar por un revisor humano.

## 9. Selección y enrutamiento de modelos

- **Modelo por defecto (MVP/V1):** modelo open-source especializado en código (Qwen2.5-Coder-32B-Instruct o equivalente), servido vía un proveedor de inferencia administrada con API compatible con OpenAI (Together.ai/Fireworks/DeepInfra). No requiere operar GPU propia ni pagar licencia de modelo, y el peso del modelo es público y auditable. Ver la justificación completa en [08 - Stack del MVP](08-mvp-fase0-stack.md).
- **MVP → V1:** el MVP usa un único prompt consolidado (sin fan-out de sub-agentes) con el mismo contrato de salida de la sección 5 — reduce superficie de fallo y costo por revisión mientras se valida el modelo/proveedor elegido. La arquitectura de fan-out (sección 2) se activa en V1 sobre el mismo `LlmPort`, sin cambiar el contrato.
- **V2/Enterprise:** enrutamiento configurable por tarea — p. ej. un modelo más rápido/económico para clasificación de severidad y resúmenes, uno con mayor capacidad de razonamiento (incluyendo modelos propietarios como Claude, si la organización lo prefiere y está dispuesta a asumir su costo) para el sub-agente de arquitectura. La interfaz interna (`LlmPort`) abstrae el proveedor para no acoplar el resto del sistema a un único modelo.
- **Enterprise (BYO-model):** opción de enrutar a un modelo desplegado en la nube privada del cliente o on-prem para organizaciones que no pueden enviar código fuera de su perímetro — el contrato de entrada/salida (sección 5) es idéntico, solo cambia el backend del `LlmPort`.
- **Fiabilidad del contrato estructurado con modelos abiertos:** los modelos open-source son menos consistentes que los modelos de frontera cerrados al respetar un JSON schema estricto. Mitigación: usar el modo JSON/schema del proveedor cuando esté disponible, validar la respuesta con un esquema en tiempo de ejecución (p. ej. Zod) y, si falla, reintentar una vez incluyendo el error de validación en el prompt antes de marcar la revisión como fallida — nunca persistir un hallazgo que no pasó la validación de esquema.

## 10. Mejora continua y métricas del propio agente

- Cada `Finding` puede marcarse `dismissed_false_positive` con motivo (ver Flujo F en [03](03-flujos-de-trabajo.md)). Estos casos se agregan como ejemplos *few-shot* específicos del repo/organización en revisiones futuras.
- Se trackean métricas de calidad del agente por categoría y por organización: tasa de falsos positivos (vía dismissals), tasa de aceptación de sugerencias de fix, % de tests generados que se mergean sin modificación — visibles en un panel interno de calidad del producto, no solo del código del cliente.
- Estas métricas alimentan decisiones de tuning de prompts/umbrales por categoría, nunca un "reentrenamiento silencioso" no auditable.
