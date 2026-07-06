import { pipeline } from '@xenova/transformers';

type Embedder = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let embedderPromise: Promise<Embedder> | undefined;

function getEmbedder(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5') as unknown as Promise<Embedder>;
  }
  return embedderPromise;
}

/**
 * Embeddings locales en CPU (ONNX vía Transformers.js) - sin GPU, sin proveedor
 * externo. Ver docs/architecture/08-mvp-fase0-stack.md sección 5.3.
 */
export async function embedLocally(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
