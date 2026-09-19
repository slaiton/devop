import { cookies } from 'next/headers';
import { RepoSettingsForm } from '../RepoSettingsForm';
import { getSession } from '../../../../session';

interface RepoSettings {
  promotion_source_branch: string;
  promotion_target_branch: string;
  auto_create_pr_on_push: boolean;
  notify_author_on_push: boolean;
  auto_merge_on_green: boolean;
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

export default async function RepositorySettingsTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session?.role !== 'admin') {
    return <p>No autorizado.</p>;
  }

  const { id } = await params;

  let settings: RepoSettings;
  try {
    settings = await fetchJson<RepoSettings>(`/dashboard/repositories/${id}/settings`);
  } catch {
    return <p>No se pudo cargar la configuración del repositorio.</p>;
  }

  return (
    <RepoSettingsForm
      repositoryId={id}
      promotionSourceBranch={settings.promotion_source_branch}
      promotionTargetBranch={settings.promotion_target_branch}
      autoCreatePrOnPush={settings.auto_create_pr_on_push}
      notifyAuthorOnPush={settings.notify_author_on_push}
      autoMergeOnGreen={settings.auto_merge_on_green}
    />
  );
}
