import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { embedLocally, type RetrievedContextChunk } from '@devsentinel/llm-port';
import { withTenant } from '@devsentinel/database';

const CHUNK_LINES = 120;
const execFileAsync = promisify(execFile);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|rb|go|java|kt|cs|rs|sql|vue|svelte|scala|swift|c|cc|cpp|h|hpp)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage|__pycache__)\//;
const INDEX_TIME_BUDGET_MS = 45_000;
const MAX_INDEXED_FILE_BYTES = 200_000;

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => n.toFixed(8)).join(',')}]`;
}

/**
 * RAG simplificado del MVP: chunking por tamaño fijo (no AST), embeddings locales
 * en CPU. El chunking consciente de símbolos (tree-sitter) queda para V1 - ver
 * docs/architecture/04-agente-ia-arquitecto.md sección 4.
 */
@Injectable()
export class RagContextService {
  async indexAndRetrieve(
    organizationId: string,
    repositoryId: string,
    checkoutPath: string,
    diff: string,
  ): Promise<RetrievedContextChunk[]> {
    const changedFiles = this.extractChangedFiles(diff);
    await this.indexFiles(organizationId, repositoryId, checkoutPath, changedFiles);
    return this.retrieveSimilarChunks(organizationId, repositoryId, diff);
  }

  /** Búsqueda semántica libre (la usa el revisor profundo): los fragmentos más parecidos a la consulta. */
  async search(organizationId: string, repositoryId: string, query: string, limit = 5): Promise<RetrievedContextChunk[]> {
    return this.retrieveSimilarChunks(organizationId, repositoryId, query, limit);
  }

  /** Hace crecer el índice más allá de los archivos que ya pasaron por un diff: en cada revisión
   * profunda indexa unos cuantos archivos de código que todavía no están (con tope de archivos y de
   * tiempo, para no alargar el análisis). Así `semantic_search` cubre cada vez más del repo. Devuelve
   * cuántos archivos indexó. */
  async indexRepositorySample(
    organizationId: string,
    repositoryId: string,
    checkoutPath: string,
    maxNewFiles = 25,
  ): Promise<number> {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: checkoutPath, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
    const candidates = stdout
      .split('\0')
      .filter((f) => f && SOURCE_FILE.test(f) && !SKIP_DIRS.test(f))
      // Primero lo más cercano a la raíz (suele ser lo más estructural).
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (candidates.length === 0) return 0;

    const indexed = await withTenant(organizationId, async (client) => {
      const { rows } = await client.query('SELECT DISTINCT file_path FROM code_chunk_embeddings WHERE repository_id = $1', [repositoryId]);
      return new Set<string>(rows.map((r) => r.file_path));
    });

    const started = Date.now();
    let count = 0;
    for (const file of candidates) {
      if (count >= maxNewFiles || Date.now() - started > INDEX_TIME_BUDGET_MS) break;
      if (indexed.has(file)) continue;
      try {
        const info = await stat(join(checkoutPath, file));
        if (info.size > MAX_INDEXED_FILE_BYTES) continue;
      } catch {
        continue;
      }
      await this.indexFiles(organizationId, repositoryId, checkoutPath, [file]);
      count += 1;
    }
    return count;
  }

  private extractChangedFiles(diff: string): string[] {
    const files = new Set<string>();
    for (const line of diff.split('\n')) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      if (match) files.add(match[1]);
    }
    return [...files];
  }

  private async indexFiles(
    organizationId: string,
    repositoryId: string,
    checkoutPath: string,
    files: string[],
  ): Promise<void> {
    for (const relPath of files) {
      let content: string;
      try {
        content = await readFile(join(checkoutPath, relPath), 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += CHUNK_LINES) {
        const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
        if (!chunk.trim()) continue;
        const embedding = await embedLocally(chunk);
        await this.upsertChunk(organizationId, repositoryId, relPath, i, chunk, embedding);
      }
    }
  }

  private async upsertChunk(
    organizationId: string,
    repositoryId: string,
    filePath: string,
    chunkIndex: number,
    content: string,
    embedding: number[],
  ): Promise<void> {
    const chunkHash = createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex').slice(0, 32);
    await withTenant(organizationId, async (client) => {
      await client.query(
        `INSERT INTO code_chunk_embeddings (organization_id, repository_id, file_path, chunk_hash, content, embedding, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (repository_id, file_path, chunk_hash)
         DO UPDATE SET content = $5, embedding = $6, updated_at = now()`,
        [organizationId, repositoryId, filePath, chunkHash, content, toVectorLiteral(embedding)],
      );
    });
  }

  private async retrieveSimilarChunks(
    organizationId: string,
    repositoryId: string,
    text: string,
    limit = 5,
  ): Promise<RetrievedContextChunk[]> {
    const queryEmbedding = await embedLocally(text.slice(0, 2000));
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT file_path, content
         FROM code_chunk_embeddings
         WHERE repository_id = $1
         ORDER BY embedding <=> $2
         LIMIT $3`,
        [repositoryId, toVectorLiteral(queryEmbedding), limit],
      );
      return rows.map((r) => ({ filePath: r.file_path, content: r.content }));
    });
  }
}
