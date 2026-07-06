import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { embedLocally, type RetrievedContextChunk } from '@devsentinel/llm-port';
import { withTenant } from '@devsentinel/database';

const CHUNK_LINES = 120;

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
    diff: string,
  ): Promise<RetrievedContextChunk[]> {
    const queryEmbedding = await embedLocally(diff.slice(0, 2000));
    return withTenant(organizationId, async (client) => {
      const { rows } = await client.query(
        `SELECT file_path, content
         FROM code_chunk_embeddings
         WHERE repository_id = $1
         ORDER BY embedding <=> $2
         LIMIT 5`,
        [repositoryId, toVectorLiteral(queryEmbedding)],
      );
      return rows.map((r) => ({ filePath: r.file_path, content: r.content }));
    });
  }
}
