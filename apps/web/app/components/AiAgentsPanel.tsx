'use client';

import { useState, type FormEvent } from 'react';

export type AgentKind = 'openai' | 'deepseek' | 'xai' | 'bedrock' | 'custom';
export type RoutingMode = 'failover' | 'round_robin';

export interface AgentProvider {
  id: string;
  name: string;
  kind: AgentKind;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  position: number;
  enabled: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface AgentsConfig {
  mode: RoutingMode;
  providers: AgentProvider[];
}

interface Preset {
  kind: AgentKind;
  label: string;
  name: string;
  baseUrl: string;
  models: string[];
  hint: string;
}

const PRESETS: Preset[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    hint: 'Crea la API key en platform.openai.com. Los modelos de razonamiento (o…, gpt-5…) funcionan, pero tardan más.',
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    hint: 'deepseek-reasoner no acepta herramientas: el análisis profundo pasaría al siguiente agente o al modo estándar.',
  },
  {
    kind: 'xai',
    label: 'Grok (xAI)',
    name: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3'],
    hint: 'Crea la API key en console.x.ai.',
  },
  {
    kind: 'bedrock',
    label: 'Amazon Bedrock',
    name: 'GPT-5.6 Sol (Bedrock)',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    models: ['global.openai.gpt-5.6-sol', 'us.openai.gpt-5.6-sol'],
    hint: 'Pega la clave API de Bedrock (consola de Bedrock → API keys) y cambia us-east-1 en la URL por tu región. En bedrock-runtime el modelo se llama con un perfil de inferencia: global.… (más barato, puede enrutar a cualquier región) o us.… (solo EE. UU.). La identidad IAM de la clave necesita bedrock:InvokeModel sobre el perfil y sobre project/default.',
  },
  {
    kind: 'custom',
    label: 'Otro (compatible con OpenAI)',
    name: '',
    baseUrl: '',
    models: [],
    hint: 'Cualquier servicio con la API de OpenAI (/chat/completions): Together, Groq, OpenRouter, Azure, un servidor propio…',
  },
];

const presetOf = (kind: AgentKind): Preset => PRESETS.find((p) => p.kind === kind) ?? PRESETS[PRESETS.length - 1];

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

interface FormState {
  kind: AgentKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  enabled: boolean;
}

const emptyForm = (kind: AgentKind): FormState => {
  const p = presetOf(kind);
  return { kind, name: p.name, baseUrl: p.baseUrl, model: p.models[0] ?? '', apiKey: '', clearApiKey: false, enabled: true };
};

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = Array.isArray(json?.message) ? json.message.join(', ') : json?.message;
    throw new Error(message ?? `error ${res.status}`);
  }
  return json as T;
}

const API = '/api/system-settings/llm';

/** Agentes de IA: los proveedores de LLM que analizan los commits, su orden y cómo se reparte el trabajo
 * entre ellos (respaldo o intercalado). */
export function AiAgentsPanel({ initial }: { initial: AgentsConfig }) {
  const [config, setConfig] = useState<AgentsConfig>(initial);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm('openai'));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});

  const { providers, mode } = config;
  const enabled = providers.filter((p) => p.enabled);

  async function act<T extends AgentsConfig>(key: string, fn: () => Promise<T>): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      setConfig(await fn());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** El modo cambia al instante en pantalla; si el servidor lo rechaza, vuelve al anterior. */
  async function changeMode(next: RoutingMode) {
    if (next === mode) return;
    const previous = mode;
    setConfig((c) => ({ ...c, mode: next }));
    setBusy('mode');
    setError(null);
    try {
      setConfig(await request<AgentsConfig>(`${API}/routing`, 'PATCH', { mode: next }));
    } catch (err) {
      setConfig((c) => ({ ...c, mode: previous }));
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function startNew(kind: AgentKind) {
    setForm(emptyForm(kind));
    setEditing('new');
    setError(null);
  }

  function startEdit(p: AgentProvider) {
    setForm({ kind: p.kind, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '', clearApiKey: false, enabled: p.enabled });
    setEditing(p.id);
    setError(null);
  }

  function pickPreset(kind: AgentKind) {
    const p = presetOf(kind);
    setForm((f) => ({ ...f, kind, name: f.name && editing !== 'new' ? f.name : p.name, baseUrl: p.baseUrl || f.baseUrl, model: p.models[0] ?? f.model }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      kind: form.kind,
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      enabled: form.enabled,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      ...(form.clearApiKey ? { clearApiKey: true } : {}),
    };
    const ok =
      editing === 'new'
        ? await act('save', () => request<AgentsConfig>(`${API}/providers`, 'POST', body))
        : await act('save', () => request<AgentsConfig>(`${API}/providers/${editing}`, 'PATCH', body));
    if (ok) setEditing(null);
  }

  function move(index: number, delta: -1 | 1) {
    const ids = providers.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void act(`move-${providers[index].id}`, () => request<AgentsConfig>(`${API}/order`, 'PUT', { ids }));
  }

  async function runTest(p: AgentProvider) {
    setBusy(`test-${p.id}`);
    setTests((t) => {
      const next = { ...t };
      delete next[p.id];
      return next;
    });
    try {
      const r = await request<{ ok: boolean; latencyMs: number; reply?: string; error?: string }>(`${API}/providers/${p.id}/test`, 'POST');
      setTests((t) => ({ ...t, [p.id]: r.ok ? { ok: true, text: `Responde correctamente (${r.latencyMs} ms)` } : { ok: false, text: r.error ?? 'falló' } }));
      setConfig(await request<AgentsConfig>(API, 'GET'));
    } catch (err) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, text: (err as Error).message } }));
    } finally {
      setBusy(null);
    }
  }

  /** Etiqueta de rol según el modo y la posición entre los activos. */
  function roleOf(p: AgentProvider): string {
    if (!p.enabled) return 'Desactivado';
    const idx = enabled.findIndex((x) => x.id === p.id);
    if (mode === 'round_robin') return enabled.length > 1 ? 'En rotación' : 'Único activo';
    return idx === 0 ? 'Principal' : `Respaldo ${idx}`;
  }

  const orderLine = enabled.length
    ? enabled.map((p) => p.name).join(mode === 'round_robin' ? ' ⇄ ' : ' → ')
    : null;
  const preset = presetOf(form.kind);

  return (
    <section className="agents-panel" aria-labelledby="agents-title">
      <h2 id="agents-title">Agentes de IA</h2>
      <p className="agents-lead">
        Los agentes son los modelos que revisan cada commit. Conecta uno o varios (OpenAI, DeepSeek, Grok u otro compatible con la API de
        OpenAI) y decide en qué orden se usan.
      </p>

      <fieldset className="depth-picker">
        <legend>Cómo se usan</legend>
        <label className="depth-option">
          <input
            type="radio"
            name="agents-mode"
            checked={mode === 'failover'}
            disabled={busy !== null}
            onChange={() => void changeMode('failover')}
          />
          <span>
            <strong>Respaldo</strong>
            <small>
              Se usa siempre el primero de la lista. Si falla (caído, sin saldo, límite de uso, error), el análisis pasa solo al siguiente.
              Los demás son el respaldo.
            </small>
          </span>
        </label>
        <label className="depth-option">
          <input
            type="radio"
            name="agents-mode"
            checked={mode === 'round_robin'}
            disabled={busy !== null}
            onChange={() => void changeMode('round_robin')}
          />
          <span>
            <strong>Intercalar</strong>
            <small>
              Cada análisis lo hace el siguiente agente activo, por turnos: reparte el costo y los límites de uso. Si el que toca falla, sigue
              el siguiente de la rotación.
            </small>
          </span>
        </label>
      </fieldset>

      {orderLine && (
        <p className="agents-order" aria-live="polite">
          {mode === 'round_robin' ? 'Rotación' : 'Orden de uso'}: <strong>{orderLine}</strong>
        </p>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}

      {providers.length === 0 ? (
        <div className="agents-empty">
          <p>
            <strong>Todavía no hay ningún agente.</strong> Sin al menos uno activo, los commits no se pueden analizar.
          </p>
          <div className="agents-presets">
            {PRESETS.map((p) => (
              <button key={p.kind} type="button" onClick={() => startNew(p.kind)}>
                Agregar {p.kind === 'custom' ? 'otro' : p.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="agent-list">
          {providers.map((p, i) => (
            <li key={p.id} className={`agent-card${p.enabled ? '' : ' agent-off'}`}>
              <span className="agent-pos" aria-label={`Posición ${i + 1}`}>{i + 1}</span>
              <div className="agent-main">
                <div className="agent-title">
                  <strong>{p.name}</strong>
                  <span className={`agent-role${p.enabled ? '' : ' agent-role-off'}`}>{roleOf(p)}</span>
                </div>
                <div className="agent-meta">
                  <code>{p.model}</code> · {p.baseUrl.replace(/^https?:\/\//, '')} · {p.apiKeySet ? 'clave guardada' : <span className="status-warn">sin clave</span>}
                </div>
                <div className="agent-meta">
                  Último uso: {timeAgo(p.lastUsedAt)}
                  {p.lastError && !tests[p.id] && (!p.lastUsedAt || (p.lastErrorAt && new Date(p.lastErrorAt) > new Date(p.lastUsedAt))) && (
                    <span className="agent-error"> · ✕ falló {timeAgo(p.lastErrorAt)}: {p.lastError}</span>
                  )}
                </div>
                {tests[p.id] && (
                  <div className={tests[p.id].ok ? 'status-ok agent-test' : 'error-text agent-test'} role="status">
                    {tests[p.id].ok ? '✓ ' : '✕ '}
                    {tests[p.id].text}
                  </div>
                )}
              </div>
              <div className="agent-actions">
                <button type="button" className="ready-link" onClick={() => move(i, -1)} disabled={i === 0 || busy !== null} aria-label={`Subir ${p.name}`} title="Subir">↑</button>
                <button type="button" className="ready-link" onClick={() => move(i, 1)} disabled={i === providers.length - 1 || busy !== null} aria-label={`Bajar ${p.name}`} title="Bajar">↓</button>
                <button type="button" className="ready-link" onClick={() => void runTest(p)} disabled={busy !== null}>
                  {busy === `test-${p.id}` ? 'Probando…' : 'Probar'}
                </button>
                <button
                  type="button"
                  className="ready-link"
                  onClick={() => void act(`toggle-${p.id}`, () => request<AgentsConfig>(`${API}/providers/${p.id}`, 'PATCH', { enabled: !p.enabled }))}
                  disabled={busy !== null}
                >
                  {p.enabled ? 'Desactivar' : 'Activar'}
                </button>
                <button type="button" className="ready-link" onClick={() => startEdit(p)} disabled={busy !== null}>Editar</button>
                <button
                  type="button"
                  className="ready-link agent-delete"
                  onClick={() => {
                    if (window.confirm(`¿Eliminar el agente "${p.name}"?`)) void act(`del-${p.id}`, () => request<AgentsConfig>(`${API}/providers/${p.id}`, 'DELETE'));
                  }}
                  disabled={busy !== null}
                >
                  Eliminar
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing === null && providers.length > 0 && (
        <p>
          <button type="button" onClick={() => startNew('openai')}>Agregar agente</button>
        </p>
      )}

      {editing !== null && (
        <form className="agent-form" onSubmit={submit}>
          <h3>{editing === 'new' ? 'Nuevo agente' : 'Editar agente'}</h3>
          <p>
            <label>
              Tipo
              <select value={form.kind} onChange={(e) => pickPreset(e.target.value as AgentKind)}>
                {PRESETS.map((p) => (
                  <option key={p.kind} value={p.kind}>{p.label}</option>
                ))}
              </select>
            </label>
          </p>
          <p className="agents-hint">{preset.hint}</p>
          <p>
            <label>
              Nombre (el que verás en el orden y en cada análisis)
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required />
            </label>
          </p>
          <p>
            <label>
              URL base
              <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" required />
            </label>
          </p>
          <p>
            <label>
              Modelo
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} list="agent-models" required />
              <datalist id="agent-models">
                {preset.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </p>
          <p>
            <label>
              API key {editing !== 'new' && providers.find((p) => p.id === editing)?.apiKeySet && <span className="status-ok">(guardada)</span>}
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={editing !== 'new' ? '•••••••• (vacío = conservar la actual)' : 'sk-…'}
              />
            </label>
          </p>
          {editing !== 'new' && providers.find((p) => p.id === editing)?.apiKeySet && (
            <p>
              <label className="agent-inline">
                <input type="checkbox" checked={form.clearApiKey} onChange={(e) => setForm({ ...form, clearApiKey: e.target.checked })} />
                Quitar la clave guardada
              </label>
            </p>
          )}
          <p>
            <label className="agent-inline">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Activo (participa en los análisis)
            </label>
          </p>
          <div className="agent-form-actions">
            <button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Guardando…' : 'Guardar agente'}</button>
            <button type="button" className="ready-link" onClick={() => setEditing(null)} disabled={busy !== null}>Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
