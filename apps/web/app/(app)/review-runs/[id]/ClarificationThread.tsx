'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface ClarificationMessage {
  id: string;
  finding_id: string;
  role: 'ai' | 'developer' | 'system';
  body: string;
  author_login: string | null;
  source: 'platform' | 'github' | 'ai';
  created_at: string;
}

export interface QuestionFinding {
  id: string;
  title: string;
  severity: string;
  category: string;
  file_path: string;
  line_start: number | null;
  explanation: string;
  question: string | null;
  needs_human: boolean;
  clarification_round: number;
}

const ROLE_LABEL = { ai: '🤖 DevSentinel AI', developer: '👤', system: '🛡 Administrador' } as const;
const POLL_MS = 3000;
const POLL_FOR_MS = 3 * 60_000;

async function send<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : (data.message ?? `error ${res.status}`));
  return data as T;
}

/** Una pregunta de la IA sobre un hallazgo que no pudo comprobar: la conversación, el formulario para responder y, para un
 * admin, la decisión manual. Tras responder, la página se actualiza sola cuando la IA termina de reevaluar. */
export function ClarificationThread({
  finding,
  messages,
  isAdmin,
  canAnswer,
}: {
  finding: QuestionFinding;
  messages: ClarificationMessage[];
  isAdmin: boolean;
  canAnswer: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<null | 'confirm' | 'dismiss'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const startedWaiting = useRef<number | null>(null);

  const last = messages[messages.length - 1];
  // La última palabra es de una persona: la IA está (o estará enseguida) reevaluando.
  const evaluating = (last?.role === 'developer' || waiting) && !finding.needs_human;

  const poll = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    if (!evaluating) {
      startedWaiting.current = null;
      return;
    }
    startedWaiting.current ??= Date.now();
    const timer = setInterval(() => {
      if (startedWaiting.current && Date.now() - startedWaiting.current > POLL_FOR_MS) {
        clearInterval(timer);
        setWaiting(false);
        return;
      }
      poll();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [evaluating, poll]);

  // Cuando llega la respuesta de la IA, deja de esperar.
  useEffect(() => {
    if (last?.role === 'ai' || last?.role === 'system') setWaiting(false);
  }, [last?.id, last?.role]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await send(`/dashboard/findings/${finding.id}/clarifications`, { body: text });
      setText('');
      setWaiting(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function decide(decision: 'confirm' | 'dismiss') {
    setError(null);
    try {
      await send(`/dashboard/findings/${finding.id}/clarification-decision`, { decision, comment: note });
      setDeciding(null);
      setNote('');
      setWaiting(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <article className="qa-card" aria-label={`Pregunta de la IA: ${finding.title}`}>
      <header className="qa-head">
        <strong>{finding.title}</strong>
        <span className="qa-where">
          {finding.file_path}
          {finding.line_start ? `:${finding.line_start}` : ''}
        </span>
        {finding.needs_human ? (
          <span className="qa-state qa-state-human">Pendiente de decisión de una persona</span>
        ) : evaluating ? (
          <span className="qa-state qa-state-eval" role="status">La IA está evaluando la respuesta…</span>
        ) : (
          <span className="qa-state qa-state-wait">Esperando tu respuesta</span>
        )}
      </header>

      <p className="qa-why">{finding.explanation}</p>

      <ol className="qa-thread">
        {messages.map((m) => (
          <li key={m.id} className={`qa-msg qa-msg-${m.role}`}>
            <span className="qa-author">
              {m.role === 'developer' ? `${ROLE_LABEL.developer} ${m.author_login ?? 'Desarrollador'}${m.source === 'github' ? ' (GitHub)' : ''}` : ROLE_LABEL[m.role]}
            </span>
            <span className="qa-body">{m.body}</span>
          </li>
        ))}
      </ol>

      {canAnswer && !evaluating && (
        <form className="qa-form" onSubmit={submit}>
          <label>
            {finding.needs_human ? 'Agrega información (la IA volverá a evaluar)' : 'Tu respuesta'}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Ej.: ya actualizamos el consumidor en acme/otro-repo, archivo src/client.ts (commit abc1234)"
              required
            />
          </label>
          <p className="qa-hint">Si depende de otro repositorio, indica cuál (owner/repo) y qué archivo revisar: la IA lo verificará en GitHub.</p>
          <button type="submit" disabled={sending || !text.trim()}>
            {sending ? 'Enviando…' : 'Enviar respuesta'}
          </button>
        </form>
      )}

      {isAdmin && (
        <div className="qa-admin">
          <span>Decisión de administrador:</span>
          {deciding === null ? (
            <>
              <button type="button" className="ready-link" onClick={() => setDeciding('confirm')}>Confirmar como hallazgo real</button>
              <button type="button" className="ready-link" onClick={() => setDeciding('dismiss')}>Descartar</button>
            </>
          ) : (
            <div className="qa-decide">
              <label>
                Comentario (opcional)
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              </label>
              <button type="button" onClick={() => void decide(deciding)}>
                {deciding === 'confirm' ? 'Confirmar hallazgo' : 'Descartar hallazgo'}
              </button>
              <button type="button" className="ready-link" onClick={() => setDeciding(null)}>Cancelar</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </article>
  );
}
