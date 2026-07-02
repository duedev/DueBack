import type { Extraction } from "../extract.ts";
import type { Flag, LogoMatch } from "../../types.ts";
import type { VendorMatch } from "../../config/vendors.ts";
import type { LogoHit } from "./index.ts";
import { normalizeGlyphs, similarityRatio } from "../../config/vendors.ts";

// Layer 3 — fusion of the brand-identity signals:
//   · A confident exact OCR-text match is authoritative (the printed name IS
//     the merchant); glyph matches are near-authoritative.
//   · Otherwise, a visual logo hit at/above LOGO_ACCEPT fills a blank vendor or
//     confirms/overrides a shaky one when the two roughly agree.
//   · A strong logo hit that CONTRADICTS a confident text vendor is not
//     silently adopted — it becomes a review flag. Humans break ties here.

export const LOGO_ACCEPT = 0.78;
/** Below this text-vs-brand similarity the two names are "different". */
const AGREE_RATIO = 0.5;

export interface FusionResult {
  /** Adopt this vendor name (canonical brand), when set. */
  vendor?: { value: string; confidence: number };
  /** Adopt this category, when set. */
  category?: { value: LogoHit["category"]; confidence: number };
  logoMatch?: LogoMatch;
  flags: Flag[];
}

export function fuseVendorIdentity(
  ex: Extraction,
  textMatch: VendorMatch | null,
  logoHit: LogoHit | null,
): FusionResult {
  const flags: Flag[] = [];

  // Text identity wins outright.
  if (textMatch) {
    return {
      flags,
      logoMatch: {
        brand: textMatch.name,
        score: textMatch.via === "exact" ? 1 : 0.95,
        source: "ocr",
      },
    };
  }

  if (!logoHit || logoHit.score < LOGO_ACCEPT) return { flags };

  const textVendor = ex.vendor.value.trim();
  const agrees =
    !textVendor ||
    similarityRatio(normalizeGlyphs(textVendor), normalizeGlyphs(logoHit.name)) >=
      AGREE_RATIO;

  if (agrees) {
    return {
      vendor: {
        value: logoHit.name,
        confidence: Math.max(ex.vendor.confidence, Math.min(0.95, logoHit.score)),
      },
      category: { value: logoHit.category, confidence: 0.85 },
      logoMatch: { brand: logoHit.name, score: logoHit.score, source: "logo" },
      flags,
    };
  }

  // Conflict: confident logo vs different printed text → human review.
  flags.push({
    code: "logo_mismatch",
    severity: "warn",
    message: `Logo looks like ${logoHit.name} (${Math.round(logoHit.score * 100)}%), but the text reads "${textVendor}".`,
  });
  return {
    logoMatch: { brand: logoHit.name, score: logoHit.score, source: "logo" },
    flags,
  };
}
