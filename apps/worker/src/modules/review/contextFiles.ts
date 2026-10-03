import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { ContextFile } from '@devsentinel/git-providers';

const CONTEXT_FILE_NAME = /^(claude|agents?)\.md$/i;
const MAX_BYTES = 40_000;

async function readFrom(dir: string, relativeDir: string): Promise<ContextFile[]> {
  let entries;
  try {
    entries = await readdir(join(dir, relativeDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: ContextFile[] = [];
  for (const entry of entries) {
    // isFile() es false para symlinks: un CLAUDE.md que apunte fuera del checkout
    // (p. ej. a un archivo del propio worker) no se lee.
    if (!entry.isFile() || !CONTEXT_FILE_NAME.test(entry.name)) continue;
    const content = (await readFile(join(dir, relativeDir, entry.name), 'utf8')).slice(0, MAX_BYTES);
    if (content.trim()) files.push({ path: relativeDir ? `${relativeDir}/${entry.name}` : entry.name, content });
  }
  return files;
}

/** CLAUDE.md / AGENTS.md (cualquier capitalización) en la raíz y en `.claude/` del checkout. */
export async function readLocalContextFiles(checkoutPath: string): Promise<ContextFile[]> {
  return [...(await readFrom(checkoutPath, '')), ...(await readFrom(checkoutPath, '.claude'))];
}
