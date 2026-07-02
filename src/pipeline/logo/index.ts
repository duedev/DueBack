import BUNDLED from "../../data/logoIndex.json";
import { repo } from "../../store/repo.ts";
import { uid } from "../../util/id.ts";
import {
  getEmbedder,
  cosineSimilarity,
  l2Normalize,
  LOGO_MODEL_ID,
} from "./embedder.ts";
import type { Category, StoredBrand } from "../../types.ts";

// The brand-logo embedding index: a curated bundled set plus every brand the
// user has taught by uploading a logo image (zero-shot — embed and append, no
// retraining). Nearest-neighbor is plain cosine over a few hundred vectors,
// so v1 keeps it client-side; a pgvector-backed search can slot in behind
// `searchLogo` when the index outgrows the bundle.

export interface LogoHit {
  name: string;
  category: Category;
  score: number; // cosine similarity 0..1
}

interface IndexEntry {
  name: string;
  category: Category;
  embedding: Float32Array;
}

interface BundledEntry {
  name: string;
  category: string;
  model: string;
  embedding: number[];
}

const bundledEntries: IndexEntry[] = (BUNDLED as BundledEntry[])
  .filter((e) => e.model === LOGO_MODEL_ID && Array.isArray(e.embedding))
  .map((e) => ({
    name: e.name,
    category: e.category as Category,
    embedding: l2Normalize(new Float32Array(e.embedding)),
  }));

/** True when there is anything to match against — the logo layer is inert
 *  (and the embedding model is never downloaded) until this is non-empty. */
export async function logoIndexAvailable(): Promise<boolean> {
  if (bundledEntries.length > 0) return true;
  return (await repo.listBrands()).length > 0;
}

async function allEntries(): Promise<IndexEntry[]> {
  const user = await repo.listBrands();
  return [
    ...bundledEntries,
    ...user.map((b) => ({
      name: b.name,
      category: b.category,
      embedding: l2Normalize(new Float32Array(b.embedding)),
    })),
  ];
}

/** Crop the candidate logo region — the receipt's header band. (A YOLO logo
 *  detector can replace this crop behind the same signature.) */
export async function cropHeaderBand(image: Blob, fraction = 0.25): Promise<Blob> {
  const bmp = await createImageBitmap(image);
  const h = Math.max(1, Math.round(bmp.height * fraction));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, bmp.width, h, 0, 0, bmp.width, h);
  bmp.close();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("crop encode failed"))),
      "image/jpeg",
      0.9,
    ),
  );
}

/** Embed the candidate region and return the nearest brand, or null when the
 *  index is empty. */
export async function searchLogo(region: Blob): Promise<LogoHit | null> {
  const entries = await allEntries();
  if (entries.length === 0) return null;
  const query = await getEmbedder().embed(region);
  let best: LogoHit | null = null;
  for (const e of entries) {
    const score = cosineSimilarity(query, e.embedding);
    if (!best || score > best.score) {
      best = { name: e.name, category: e.category, score };
    }
  }
  return best;
}

/** Teach the app a new brand from a reference logo image. Stored locally
 *  (and synced to `brand_logos` when signed in). */
export async function addBrandFromImage(
  name: string,
  category: Category,
  logo: Blob,
): Promise<StoredBrand> {
  const embedding = await getEmbedder().embed(logo);
  const brand: StoredBrand = {
    id: uid("brand"),
    name: name.trim(),
    category,
    embedding: [...embedding],
    createdAt: Date.now(),
  };
  await repo.putBrand(brand);
  return brand;
}
