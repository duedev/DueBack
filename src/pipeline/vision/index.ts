import type { Extraction } from "../extract.ts";
import type { AssistProvenance, OcrLine } from "../../types.ts";
import type { Strategy, VisionExtraction } from "./types.ts";
import { getVisionConfig, withinBudget, recordSpend, type VisionConfig } from "./config.ts";
import { effectiveStrategy, endpointProblem, resolveEndpoint, type Endpoint } from "./endpoint.ts";
import { visionToExtraction } from "./schema.ts";
import { assistProvenance, settleAssistExtraction } from "./provenance.ts";
import { createClient } from "./clients/index.ts";
import { blobToBase64 } from "./clients/shared.ts";
import { runOneShot, type ImagePart } from "./strategies/oneshot.ts";
import { runAgentic } from "./strategies/agentic.ts";
import type { AgentContext } from "./strategies/tools.ts";
import { CONFIDENCE } from "../../config/constants.ts";
import { isAbortError, throwIfAborted } from "../../util/abort.ts";

// Tier 3 orchestration: resolve the backend to an endpoint, pick the
// strategy, decide when to spend, and fall back to the rules result on any
// failure so an AI call can only ever *help*.

/** Trigger condition: the free rules path is unsure about this receipt. */
export function shouldAssist(ex: Extraction): boolean {
  return ex.confidence < CONFIDENCE.reviewBelow || ex.amount.value <= 0;
}

export interface AssistPlan {
  endpoint: Endpoint;
  strategy: Strategy;
}

/** The endpoint + strategy a call would use right now — the signed-in proxy
 *  applied — or why none can run. Shared by the pipeline and the settings
 *  probe so "Test connection" exercises the same path a real receipt takes. */
export async function planAssist(
  cfg: VisionConfig,
): Promise<{ plan: AssistPlan; problem: null } | { plan: null; problem: string }> {
  const endpoint = await withServerProxy(resolveEndpoint(cfg), cfg.cloud.apiKey);
  const problem = endpointProblem(endpoint);
  if (problem) return { plan: null, problem };
  return { plan: { endpoint, strategy: effectiveStrategy(endpoint, cfg.strategy) }, problem: null };
}

/** Signed-in users route the cloud OpenRouter call through the key-holding
 *  Edge Function so no API key ever lives in the browser (their own key, if
 *  set, still wins). Other endpoints never load the sync chunk at all. */
async function withServerProxy(ep: Endpoint, ownKey: string): Promise<Endpoint> {
  if (ep.backend !== "cloud" || !ep.openRouter) return ep;
  try {
    const { serverProxyOverride } = await import("../../supabase/aiProxy.ts");
    return (await serverProxyOverride(ep, ownKey)) ?? ep;
  } catch {
    return ep; // sync layer absent/unconfigured — keep the local endpoint
  }
}

function runPlan(
  plan: AssistPlan,
  image: ImagePart,
  ctx: AgentContext,
  pause?: AbortSignal,
): Promise<VisionExtraction> {
  const client = createClient(plan.endpoint, pause);
  const opts = {
    onCost: recordSpend,
    canSpend: plan.endpoint.metered ? () => withinBudget() : undefined,
    maxTokens: plan.endpoint.maxTokens,
  };
  return plan.strategy === "agentic"
    ? runAgentic(client, image, ctx, opts)
    : runOneShot(client, image, opts);
}

export interface VisionAssist {
  /** The model's read, with boxes anchored on the on-device OCR lines and
   *  corroboration flags where the OCR contradicts it (provenance.ts). */
  extraction: Extraction;
  costUsd: number;
  /** Who read it and how — stored as `Receipt.assist`. */
  provenance: AssistProvenance;
}

/**
 * Run the AI assist for a low-confidence receipt, if configured (and, for a
 * metered cloud backend, within budget). Returns null — leaving the rules
 * result untouched — when the tier is off, not triggered, over budget, or
 * the call fails. `lines` is the on-device OCR read: the agent can search it,
 * and the answer's boxes are anchored on it (a model returns values only).
 * `opts.signal` is the reading pause: it aborts a free (local/self-hosted)
 * call and rethrows its AbortError so the pipeline requeues the receipt; a
 * metered call never listens (visionFetch).
 */
export async function runVisionAssist(
  image: Blob,
  ex: Extraction,
  lines: OcrLine[] = [],
  opts: { signal?: AbortSignal } = {},
): Promise<VisionAssist | null> {
  if (!shouldAssist(ex)) return null;
  const cfg = getVisionConfig();
  if (!cfg.enabled) return null;
  const { plan } = await planAssist(cfg);
  if (!plan) return null;
  if (plan.endpoint.metered && !withinBudget(cfg)) {
    console.warn("[vision] spend cap reached — skipping the paid fallback.");
    return null;
  }
  // Nothing is billed before runPlan's first request: a pause that landed
  // while the plan resolved (the proxy's session lookup) still unwinds free.
  throwIfAborted(opts.signal);
  try {
    const result = await runPlan(
      plan,
      { type: "image", ...(await blobToBase64(image)) },
      { draft: ex, lines },
      opts.signal,
    );
    // `ex` is the rules draft (after the rescue swap and logo fusion), read
    // from the same OCR lines, so its boxes share their frame. The vendor is
    // vetted FIRST (visionToExtraction: a card network or the city falls
    // back to the printed brand, a clean rules header, or blank), and only
    // then does the settle step anchor boxes on the values as they stand.
    // Both steps are total — the answer is already billed and must never be
    // discarded by bookkeeping.
    return {
      extraction: settleAssistExtraction(visionToExtraction(result.fields, { draft: ex, lines }), ex, lines),
      costUsd: result.costUsd,
      provenance: assistProvenance({
        endpoint: plan.endpoint,
        requested: cfg.strategy,
        strategy: plan.strategy,
        result,
        draft: ex,
      }),
    };
  } catch (err) {
    // A paused free call is not a failure: swallowed here, the receipt would
    // complete with the rules-only result instead of going back to the queue.
    if (opts.signal?.aborted && isAbortError(err)) throw err;
    console.warn("[vision] AI assist failed; keeping the on-device result.", err);
    return null;
  }
}

/** A connectivity probe for the settings panel: one real run of the chosen
 *  strategy on a tiny synthetic image. */
export async function testVisionConnection(
  cfg: VisionConfig,
): Promise<{ ok: boolean; message: string }> {
  const { plan, problem } = await planAssist(cfg);
  if (!plan) return { ok: false, message: problem };
  try {
    const image: ImagePart = { type: "image", ...(await blobToBase64(await tinyTestImage())) };
    const res = await runPlan(plan, image, { draft: null, lines: [] });
    const via = plan.endpoint.viaProxy ? " through your account" : "";
    // The free router names its pick per request — say which model answered.
    const served = res.servedModel && res.servedModel !== plan.endpoint.model ? ` → ${res.servedModel}` : "";
    const how =
      plan.strategy === "agentic" ? ` (agentic, ${res.calls} call${res.calls === 1 ? "" : "s"})` : "";
    const downgraded =
      cfg.strategy === "agentic" && plan.strategy === "oneshot"
        ? " Agentic needs your own key: the account proxy relays one-shot reads only."
        : "";
    return {
      ok: true,
      message: `${plan.endpoint.label} · ${plan.endpoint.model}${served} answered${via}${how}.${downgraded}`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function tinyTestImage(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 200, 80);
    ctx.fillStyle = "#000";
    ctx.font = "16px sans-serif";
    ctx.fillText("TEST CAFE", 10, 28);
    ctx.fillText("2026-01-02  TOTAL 4.20", 10, 56);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))),
      "image/jpeg",
      0.85,
    ),
  );
}
