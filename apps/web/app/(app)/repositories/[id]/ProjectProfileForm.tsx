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
  migrationsPolicy: string;
  compatibilityNotes: string;
  notes: string;
  mandatoryRules: string;
  securityRules: string;
  conventions: string;
}

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
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
    return (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));
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
        body: JSON.stringify({
          language: values.language,
          framework: values.framework,
          frameworkVersion: values.frameworkVersion,
          runtime: values.runtime,
          database: values.database,
          architectureStyle: values.architectureStyle,
          testingStrategy: values.testingStrategy,
          migrationsPolicy: values.migrationsPolicy,
          compatibilityNotes: values.compatibilityNotes,
          notes: values.notes,
          mandatoryRules: toLines(values.mandatoryRules),
          securityRules: toLines(values.securityRules),
          conventions: toLines(values.conventions),
        }),
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
        <label>Versión: <input value={values.frameworkVersion} onChange={set('frameworkVersion')} placeholder="Laravel 9" /></label>
      </p>
      <p>
        <label>Runtime: <input value={values.runtime} onChange={set('runtime')} placeholder="php 8.4, node 20…" /></label>
      </p>
      <p>
        <label>Base de datos: <input value={values.database} onChange={set('database')} placeholder="postgresql, mysql…" /></label>
      </p>
      <p>
        <label>Arquitectura: <input value={values.architectureStyle} onChange={set('architectureStyle')} placeholder="Controller → Service → Repository" /></label>
      </p>
      <p>
        <label>Testing: <input value={values.testingStrategy} onChange={set('testingStrategy')} placeholder="PHPUnit / Feature + Unit" /></label>
      </p>
      <p>
        <label>
          Reglas obligatorias (una por línea):
          <textarea
            rows={3}
            value={values.mandatoryRules}
            onChange={set('mandatoryRules')}
            placeholder={'Laravel nativo\nseparación de responsabilidades'}
          />
        </label>
      </p>
      <p>
        <label>
          Reglas de seguridad (una por línea):
          <textarea
            rows={3}
            value={values.securityRules}
            onChange={set('securityRules')}
            placeholder={'No secrets\nvalidar inputs\nautorización'}
          />
        </label>
      </p>
      <p>
        <label>
          Convenciones (una por línea):
          <textarea
            rows={3}
            value={values.conventions}
            onChange={set('conventions')}
            placeholder={'PSR-12\nnaming\nestructura del proyecto'}
          />
        </label>
      </p>
      <p>
        <label>Migraciones: <input value={values.migrationsPolicy} onChange={set('migrationsPolicy')} placeholder="Toda modificación DB debe incluir migration" /></label>
      </p>
      <p>
        <label>Compatibilidad: <input value={values.compatibilityNotes} onChange={set('compatibilityNotes')} placeholder="No romper endpoints existentes" /></label>
      </p>
      <p>
        <label>Notas: <input value={values.notes} onChange={set('notes')} placeholder="particularidades del proyecto" /></label>
      </p>
      <button type="submit" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar'}
      </button>
      {saved && <span className="status-ok" style={{ marginLeft: '0.5em' }}>Guardado</span>}
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
