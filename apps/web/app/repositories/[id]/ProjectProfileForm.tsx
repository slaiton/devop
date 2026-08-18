'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

interface ProjectProfileValues {
  language: string;
  framework: string;
  frameworkVersion: string;
  runtime: string;
  database: string;
  architectureStyle: string;
  testingStrategy: string;
  notes: string;
}

export function ProjectProfileForm({
  repositoryId,
  initial,
}: {
  repositoryId: string;
  initial: ProjectProfileValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof ProjectProfileValues>(key: K) {
    return (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/dashboard/repositories/${repositoryId}/project-profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `error ${res.status}`);
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        <label>Lenguaje: <input value={values.language} onChange={set('language')} placeholder="php, typescript…" /></label>
      </p>
      <p>
        <label>Framework: <input value={values.framework} onChange={set('framework')} placeholder="laravel, nestjs…" /></label>
      </p>
      <p>
        <label>Versión del framework: <input value={values.frameworkVersion} onChange={set('frameworkVersion')} /></label>
      </p>
      <p>
        <label>Runtime: <input value={values.runtime} onChange={set('runtime')} placeholder="php 5.6, node 20…" /></label>
      </p>
      <p>
        <label>Base de datos: <input value={values.database} onChange={set('database')} placeholder="mysql, postgres…" /></label>
      </p>
      <p>
        <label>Estilo de arquitectura: <input value={values.architectureStyle} onChange={set('architectureStyle')} placeholder="clean_architecture, legacy mvc…" /></label>
      </p>
      <p>
        <label>Estrategia de testing: <input value={values.testingStrategy} onChange={set('testingStrategy')} /></label>
      </p>
      <p>
        <label>Notas: <input value={values.notes} onChange={set('notes')} placeholder="convenciones particulares del proyecto" /></label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span style={{ color: 'green', marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p style={{ color: 'crimson', fontSize: '0.85em' }}>{error}</p>}
    </form>
  );
}
