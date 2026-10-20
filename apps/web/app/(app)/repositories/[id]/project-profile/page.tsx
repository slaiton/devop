import { cookies } from 'next/headers';
import { GenerateContextButton } from '../GenerateContextButton';
import { ProjectProfileForm } from '../ProjectProfileForm';
import { getSession } from '../../../../session';

interface ProjectProfileRow {
  language: string | null;
  framework: string | null;
  framework_version: string | null;
  runtime: string | null;
  database: string | null;
  architecture_style: string | null;
  testing_strategy: string | null;
  notes: string | null;
  mandatory_rules: string[];
  security_rules: string[];
  conventions: string[];
  migrations_policy: string | null;
  compatibility_notes: string | null;
  auto_generated_from: string[] | null;
}

async function fetchJson<T>(path: string): Promise<T> {
  const cookieHeader = cookies().toString();
  const res = await fetch(`${process.env.API_INTERNAL_URL}/api${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export default async function RepositoryProjectProfileTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session?.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const { id } = await params;

  let projectProfile: ProjectProfileRow;
  try {
    projectProfile = await fetchJson<ProjectProfileRow>(`/dashboard/repositories/${id}/project-profile`);
  } catch {
    return <p>No se pudo cargar el perfil del proyecto.</p>;
  }

  const hasContent = [
    projectProfile.language,
    projectProfile.framework,
    projectProfile.runtime,
    projectProfile.database,
    projectProfile.architecture_style,
    projectProfile.testing_strategy,
    projectProfile.notes,
    projectProfile.migrations_policy,
    projectProfile.compatibility_notes,
  ].some(Boolean) ||
    [projectProfile.mandatory_rules, projectProfile.security_rules, projectProfile.conventions].some((l) => (l ?? []).length > 0);
  // "Curado" = una persona lo configuró; un borrador generado por la IA se puede regenerar completo.
  const curated = hasContent && !projectProfile.auto_generated_from;

  const initial = {
    language: projectProfile.language ?? '',
    framework: projectProfile.framework ?? '',
    frameworkVersion: projectProfile.framework_version ?? '',
    runtime: projectProfile.runtime ?? '',
    database: projectProfile.database ?? '',
    architectureStyle: projectProfile.architecture_style ?? '',
    testingStrategy: projectProfile.testing_strategy ?? '',
    migrationsPolicy: projectProfile.migrations_policy ?? '',
    compatibilityNotes: projectProfile.compatibility_notes ?? '',
    notes: projectProfile.notes ?? '',
    mandatoryRules: (projectProfile.mandatory_rules ?? []).join('\n'),
    securityRules: (projectProfile.security_rules ?? []).join('\n'),
    conventions: (projectProfile.conventions ?? []).join('\n'),
  };

  return (
    <>
      <GenerateContextButton repositoryId={id} curated={curated} />
      {projectProfile.auto_generated_from && (
        <p className="status-warn">
          Este perfil se generó automáticamente a partir de {projectProfile.auto_generated_from.join(', ')} (al
          generar el contexto o en el primer push del repositorio). Revisalo: al guardarlo a mano pasa a considerarse configurado por una persona.
        </p>
      )}
      {/* La key hace que el formulario se vuelva a montar cuando "Generar contexto" cambia el perfil. */}
      <ProjectProfileForm key={JSON.stringify(initial)} repositoryId={id} initial={initial} />
    </>
  );
}
