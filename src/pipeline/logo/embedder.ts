// The image-embedding seam for visual logo recognition. "Embedding an image"
// is a capability, not a model: the default implementation is CLIP via
// transformers.js (quantized, runs on-device, weights lazily fetched from the
// Hugging Face CDN on first use and cached by the service worker), and tests
// swap in a deterministic fake. Everything downstream only sees Float32Arrays.

export interface Embedder {
  /** L2-normalized embedding of an image. */
  embed(image: Blob): Promise<Float32Array>;
  /** Identifies the embedding space; stored with vectors so an index built
   *  with one model is never compared against another. */
  readonly modelId: string;
}

/** Small, proven CLIP vision tower for transformers.js; ~40 MB quantized. */
export const LOGO_MODEL_ID = "Xenova/clip-vit-base-patch32";

export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Inputs are L2-normalized, so the dot product is the cosine.
  return Math.max(-1, Math.min(1, dot));
}

class ClipEmbedder implements Embedder {
  readonly modelId = LOGO_MODEL_ID;
  private ready: Promise<{
    processor: (img: unknown) => Promise<Record<string, unknown>>;
    model: (inputs: Record<string, unknown>) => Promise<{ image_embeds: { data: Float32Array } }>;
    rawImageFromBlob: (b: Blob) => Promise<unknown>;
  }> | null = null;

  private async load() {
    if (!this.ready) {
      this.ready = (async () => {
        // Lazy so the multi-MB runtime + weights never load unless the logo
        // layer actually has an index to match against.
        const tf = await import("@huggingface/transformers");
        const processor = await tf.AutoProcessor.from_pretrained(this.modelId, {});
        const model = await tf.CLIPVisionModelWithProjection.from_pretrained(
          this.modelId,
          { dtype: "q8" },
        );
        return {
          processor: (img: unknown) => processor(img),
          model: (inputs: Record<string, unknown>) =>
            model(inputs) as Promise<{ image_embeds: { data: Float32Array } }>,
          rawImageFromBlob: (b: Blob) => tf.RawImage.fromBlob(b),
        };
      })();
    }
    return this.ready;
  }

  async embed(image: Blob): Promise<Float32Array> {
    const { processor, model, rawImageFromBlob } = await this.load();
    const raw = await rawImageFromBlob(image);
    const inputs = await processor(raw);
    const out = await model(inputs);
    return l2Normalize(new Float32Array(out.image_embeds.data));
  }
}

let factory: () => Embedder = () => new ClipEmbedder();
let singleton: Embedder | null = null;

/** The active embedder (lazy singleton). */
export function getEmbedder(): Embedder {
  if (!singleton) singleton = factory();
  return singleton;
}

/** Test seam: replace the embedder (pass null to restore the default). */
export function setEmbedderFactory(f: (() => Embedder) | null): void {
  factory = f ?? (() => new ClipEmbedder());
  singleton = null;
}
