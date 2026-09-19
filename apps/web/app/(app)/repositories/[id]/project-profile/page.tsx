import { cookies } from 'next/headers';
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

  return (
    <ProjectProfileForm
      repositoryId={id}
      initial={{
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
      }}
    />
  );
}
