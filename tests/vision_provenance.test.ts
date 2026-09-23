import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIST_RAW_MAX,
  CORROBORATE_MIN_RULES_CONFIDENCE,
  CORROBORATE_MIN_RULES_DATE_CONFIDENCE,
  anchorAssistBoxes,
  assistHost,
  assistKeySource,
  assistMethodDetail,
  assistProvenance,
  corroborate,
  isLegacyAiRead,
  parseLegacyMethod,
  reusableOcr,
  settleAssistExtraction,
  tailCap,
  wellFormed,
} from "../src/pipeline/vision/provenance.ts";
import { visionToExtraction } from "../src/pipeline/vision/schema.ts";
import { defaultVisionConfig, mergeVisionConfig } from "../src/pipeline/vision/config.ts";
import { resolveEndpoint } from "../src/pipeline/vision/endpoint.ts";
import { forcesManualReview, parseReceipt, WINDOW_RECOVERY_NOTE, type Extraction } from "../src/pipeline/extract.ts";
import type { AssistProvenance, BBox, OcrLine } from "../src/types.ts";

// The AI assist's answer is values only: vision/provenance.ts anchors them
// on the on-device OCR lines (the model says WHAT, the OCR says WHERE),
// flags the values the OCR contradicts, and records who read the receipt
// and how — without the endpoint's URL or key.

function lines(texts: string[]): OcrLine[] {
  return texts.map((text, i) => ({
    text,
    confidence: 90,
    bbox: { x: 0, y: i / texts.length, w: 1, h: 1 / texts.length },
    words: [],
  }));
}

/** A real OCR line from the owner's uploaded batch (text, confidence, box). */
type Raw = [string, number, number, number, number, number];
const real = (rows: Raw[]): OcrLine[] =>
  rows.map(([text, confidence, x, y, w, h]) => ({ text, confidence, bbox: { x, y, w, h }, words: [] }));

const L = lines([
  "MOBIL MART",
  "123 MAIN ST",
  "DATE 4/21/26 8:25",
  "FUEL TOTAL $ 113.61",
  "CREDIT 113.61",
  "AMERICAN EXPRESS",
]);

const D: BBox = { x: 0.11, y: 0.52, w: 0.33, h: 0.04 };
const D2: BBox = { x: 0.2, y: 0.36, w: 0.4, h: 0.05 };

/** A hand-built rules draft: explicit values and boxes. */
function draft(p: {
  vendor?: string;
  vendorBox?: BBox;
  date?: string;
  dateBox?: BBox;
  dateConfidence?: number;
  amount?: number;
  amountBox?: BBox;
  amountConfidence?: number;
}): Extraction {
  return {
    vendor: { value: p.vendor ?? "", confidence: 0.7, ...(p.vendorBox ? { bbox: p.vendorBox } : {}) },
    date: { value: p.date ?? "", confidence: p.dateConfidence ?? 0.7, ...(p.dateBox ? { bbox: p.dateBox } : {}) },
    amount: {
      value: p.amount ?? 0,
      confidence: p.amountConfidence ?? 0.7,
      ...(p.amountBox ? { bbox: p.amountBox } : {}),
    },
    tax: { value: 1.5, confidence: 0.6 },
    currency: "USD",
    category: { value: "Fuel", confidence: 0.85 },
    confidence: 0.66,
    flags: [{ code: "no_date", severity: "warn", message: "No date found." }],
  };
}

const ai = (vendor: string, date: string, amount: number): Extraction =>
  visionToExtraction({ vendor, date, amount, tax: 0, category: "Fuel" });

// ── Boxes ────────────────────────────────────────────────────────────────────

test("the model reading the rules' own amount/date reuses the draft's box, not the first line holding it", () => {
  const out = anchorAssistBoxes(
    ai("MOBIL MART", "2026-04-21", 113.61),
    draft({ vendor: "Mobil", amount: 113.61, amountBox: D, date: "2026-04-21", dateBox: D2 }),
    L,
  );
  assert.deepEqual(out.amount.bbox, D);
  assert.deepEqual(out.date.bbox, D2);
});

test("same-brand vendors are the same read — the draft's box is reused when its line names the brand", () => {
  // The receipt prints only the slogan: the model's "Home Depot" is nowhere
  // verbatim, but the rules read the brand off that slogan line.
  const slogan = lines(["HOW DOERS GET MORE DONE", "TOTAL 9.99"]);
  const sBox: BBox = { x: 0.1, y: 0.1, w: 0.5, h: 0.3 };
  const hd = anchorAssistBoxes(ai("Home Depot", "", 9.99), draft({ vendor: "The Home Depot", vendorBox: sBox }), slogan);
  assert.deepEqual(hd.vendor.bbox, sBox);

  // "MOBIL MART" vs a fuzzy-read "Mobil" on a garbled "MOBTL" line.
  const garbled = lines(["MOBTL", "TOTAL 9.99"]);
  const gBox: BBox = { x: 0.2, y: 0.1, w: 0.3, h: 0.2 };
  const mobil = anchorAssistBoxes(ai("MOBIL MART", "", 9.99), draft({ vendor: "Mobil", vendorBox: gBox }), garbled);
  assert.deepEqual(mobil.vendor.bbox, gBox);

  // "sam's club" vs a line printing "SAMS CLUB": same text once folded.
  const sams = lines(["SAMS CLUB", "TOTAL 9.99"]);
  const cBox: BBox = { x: 0.05, y: 0.05, w: 0.6, h: 0.3 };
  const sc = anchorAssistBoxes(ai("sam's club", "", 9.99), draft({ vendor: "Sam's Club", vendorBox: cBox }), sams);
  assert.deepEqual(sc.vendor.bbox, cBox);
});

test("the model's full vendor string printed verbatim is boxed whole, not the rules' alias slice", () => {
  // Real lines (fuel_03-02-26_chevron_station_inc): the rules box is the
  // "chevron" slice of the line; the model named the whole line.
  const chevron = real([
    ["3390 La Slerra Ave.", 92, 0.0891, 0.1827, 0.6343, 0.0198],
    ["chevron Station Inc.", 91, 0.0891, 0.1993, 0.6701, 0.0198],
    ["00200734", 97, 0.0891, 0.2179, 0.265, 0.0214],
    ["Riverside, CA", 96, 0.088, 0.2353, 0.4363, 0.0182],
    ["03/02/2026 694565975", 95, 0.0891, 0.2835, 0.9109, 0.021],
    ["FUEL TOTAL $¢ 83.44", 68, 0.1076, 0.6342, 0.8009, 0.0245],
  ]);
  const slice: BBox = { x: 0.0891, y: 0.1993, w: (0.6701 * 7) / 20, h: 0.0198 };
  const out = anchorAssistBoxes(
    ai("Chevron Station Inc.", "2026-03-02", 83.44),
    draft({ vendor: "Chevron", vendorBox: slice }),
    chevron,
  );
  assert.ok(out.vendor.bbox);
  assert.ok(Math.abs(out.vendor.bbox!.w - 0.6701) < 1e-6, "spans the whole name");
  assert.ok(Math.abs(out.vendor.bbox!.y - 0.1993) < 1e-6);
});

test("a rules vendor line sharing a distinctive word lends its box; generic words never do", () => {
  // Real lines (misc_07-01-25_costco_wholesale): the rules read "WHOLESALE"
  // off the logo line; the model read "Costco Wholesale".
  const costco = real([
    ["—— WHOLESALE", 0, 0.1626, 0.1108, 0.7276, 0.0204],
    ["Corona #432", 94, 0.3094, 0.1469, 0.4496, 0.0112],
    ["480 McKinley St.’", 77, 0.333, 0.1642, 0.3879, 0.015],
    ["Corona, CA 92879", 95, 0.333, 0.1827, 0.3789, 0.0135],
    ["Visa 38.05", 93, 0.2702, 0.6058, 0.6312, 0.0262],
  ]);
  const logoLine: BBox = { x: 0.1626, y: 0.1108, w: 0.7276, h: 0.0204 };
  const out = anchorAssistBoxes(
    ai("Costco Wholesale", "2025-07-01", 38.05),
    draft({ vendor: "WHOLESALE", vendorBox: logoLine }),
    costco,
  );
  assert.deepEqual(out.vendor.bbox, logoLine);

  // "station" and "inc" tie nothing together: a Shell station's line never
  // lends its box to a model that read "Chevron Station Inc.".
  const shell = lines(["SHELL STATION", "TOTAL 9.99"]);
  const none = anchorAssistBoxes(
    ai("Chevron Station Inc.", "", 9.99),
    draft({ vendor: "SHELL STATION", vendorBox: { x: 0, y: 0, w: 1, h: 0.5 } }),
    shell,
  );
  assert.equal(none.vendor.bbox, undefined);
});

test("a logo-fused draft vendor's leftover box is not reused when its line doesn't name the brand", () => {
  // Logo fusion renames the vendor but keeps the previous OCR line's box.
  const ls = lines(["JOE'S PLACE", "TOTAL 9.99"]);
  const out = anchorAssistBoxes(
    ai("Costco", "", 9.99),
    draft({ vendor: "Costco Wholesale", vendorBox: { x: 0, y: 0, w: 1, h: 0.5 } }),
    ls,
  );
  assert.equal(out.vendor.bbox, undefined);
});

test("a value the rules missed is located on the OCR lines", () => {
  const out = anchorAssistBoxes(
    ai("MOBIL MART", "2026-04-21", 113.61),
    draft({ vendor: "Mobil", amount: 61, amountBox: D }),
    L,
  );
  // The FUEL TOTAL line (y = 3/6), not the CREDIT tender and not the
  // garbled 61's box.
  assert.ok(out.amount.bbox);
  assert.equal(out.amount.bbox!.y, 0.5);
  assert.notDeepEqual(out.amount.bbox, D);
  assert.ok(out.date.bbox);
  assert.equal(out.date.bbox!.y, 2 / 6);
});

test("a box is never invented or transferred to a different value", () => {
  const out = anchorAssistBoxes(
    ai("", "", 107.38),
    draft({ vendor: "Chevron", vendorBox: D, date: "2026-03-13", dateBox: D2, amount: 187.38, amountBox: D }),
    L,
  );
  assert.equal(out.amount.bbox, undefined, "107.38 is printed nowhere; the 187.38 box stays put");
  assert.equal(out.vendor.bbox, undefined, "a blank vendor gets no box");
  assert.equal(out.date.bbox, undefined, "a blank date gets no box");
  const bare = anchorAssistBoxes(ai("Nowhere Cafe", "2026-01-02", 4.2), draft({}), []);
  assert.equal(bare.vendor.bbox, undefined);
  assert.equal(bare.date.bbox, undefined);
  assert.equal(bare.amount.bbox, undefined);
});

test("a wrong-but-printed vendor gets an honest box on the line it was read from", () => {
  // Anchoring is value-agnostic. (visionToExtraction itself now blanks a
  // card network — vetVisionVendor — so the read is built directly.)
  const wrong: Extraction = { ...ai("", "", 113.61), vendor: { value: "AMERICAN EXPRESS", confidence: 0.9 } };
  const out = anchorAssistBoxes(wrong, draft({ vendor: "Chevron", vendorBox: D }), L);
  assert.ok(out.vendor.bbox);
  assert.ok(Math.abs(out.vendor.bbox!.y - 5 / 6) < 1e-9);
});

test("a box the field already carries (a value taken from the OCR) is kept; a malformed one is re-found", () => {
  const kept: BBox = { x: 0.3, y: 0.01, w: 0.2, h: 0.05 };
  const fromOcr = { ...ai("MOBIL MART", "", 113.61) };
  fromOcr.vendor = { ...fromOcr.vendor, bbox: kept };
  fromOcr.amount = { ...fromOcr.amount, bbox: { x: 0, y: 0, w: 0, h: 0 } };
  const out = anchorAssistBoxes(fromOcr, draft({}), L);
  assert.deepEqual(out.vendor.bbox, kept);
  assert.equal(out.amount.bbox!.y, 0.5, "a zero-area box is stripped and the value located");
  // A blank value never carries a box, whatever it came with.
  const blank = ai("", "", 0);
  blank.vendor = { ...blank.vendor, bbox: kept };
  assert.equal(anchorAssistBoxes(blank, draft({}), L).vendor.bbox, undefined);
});

test("anchoring touches boxes only and never mutates the model's read", () => {
  const input = ai("MOBIL MART", "2026-04-21", 113.61);
  const before = structuredClone(input);
  const out = anchorAssistBoxes(input, draft({ vendor: "Mobil", amount: 61, amountBox: D }), L);
  assert.deepEqual(input, before);
  assert.deepEqual(out.tax, input.tax);
  assert.deepEqual(out.category, input.category);
  assert.deepEqual(out.flags, input.flags);
  assert.equal(out.confidence, input.confidence);
  assert.equal(out.vendor.value, "MOBIL MART");
  assert.equal(out.amount.value, 113.61);
  assert.equal(out.date.value, "2026-04-21");
});

// ── Corroboration ────────────────────────────────────────────────────────────

// Real lines (fuel_03-13-26_american_express): FUEL TOTAL and CREDIT both
// print 187.38; the model answered 107.38 and named the card network.
const AMEX = real([
  ["5. Hg Springs hee", 52, 0.2741, 0.1312, 0.4332, 0.0238],
  ["Baring op gpg", 24, 0.3608, 0.1523, 0.2543, 0.0192],
  ["308 g, HIGHLAND SPRI", 69, 0.1662, 0.1988, 0.6506, 0.0277],
  ["SOBHy YOUSEF", 73, 0.169, 0.2177, 0.3963, 0.0231],
  ["BANNING , CA", 81, 0.1733, 0.255, 0.527, 0.0262],
  ["83/13/2028 78883184", 72, 0.1776, 0.2927, 0.6236, 0.0254],
  ["05:31:99 AM", 73, 0.179, 0.3112, 0.3679, 0.0196],
  ["AM Express", 88, 0.1889, 0.3669, 0.3239, 0.0173],
  ["INVOICE 879212", 87, 0.1932, 0.3858, 0.4517, 0.0169],
  ["PUMP# 14", 75, 0.1861, 0.4412, 0.7784, 0.0212],
  ["Regular 18.842G", 72, 0.1491, 0.4673, 0.7045, 0.0281],
  ["PRICE/GAL . $5.899", 47, 0.1747, 0.4935, 0.6804, 0.0208],
  ["= FUEL TOTAL $ 187.38", 64, 0.1108, 0.5277, 0.7457, 0.0215],
  ["TS TOTAL S & pr", 0, 0.0227, 0.5742, 0.8224, 0.0254],
  ["CREDIT $ 187.38", 80, 0.1634, 0.6173, 0.6761, 0.0169],
  ["Contactless N", 61, 0.1591, 0.7396, 0.5781, 0.0181],
  ["AMERICAN EXPRESS", 67, 0.1605, 0.7585, 0.2699, 0.0115],
]);

// Real lines (mats_03-26-24_lowes): the date prints as 03/24/26 three times;
// the model answered 2024-03-26.
const LOWES = real([
  ["LOVE'S HOME CENTERS, ILL", 75, 0.325, 0.235, 0.3732, 0.0062],
  ["PALM DESERT, CA 92211 (760) 449-9000", 58, 0.2125, 0.2573, 0.6054, 0.0065],
  ["SALESKS S25H50n0 5376128  TRANSR: 7785376710 3 24-20", 16, 0.1054, 0.2915, 0.8268, 0.0062],
  ["SUBTUTAL: 02.00", 35, 0.4643, 0.4365, 0.4089, 0.0062],
  ["TOTAL TAX: 26.40", 82, 0.45, 0.4465, 0.425, 0.0065],
  ["THUOTCE 77° 5 TOTAL: 329.00", 53, 0.2875, 0.4573, 0.5875, 0.0065],
  ["MEX: 329.00", 58, 0.5446, 0.4677, 0.3321, 0.0065],
  ["HHEX OUCKRKXAXXKZ00 7 AMOUNT: 329.00 RUTHIE: 827507", 28, 0.1089, 0.5758, 0.8161, 0.0062],
  ["CEP REF 10: 256306000321 03/24/26 11:44:70", 17, 0.1911, 0.5865, 0.6571, 0.0062],
  ["STONE: 2563 TERMINAL: 06 03/24/26 11:44:31", 45, 0.1357, 0.6292, 0.7196, 0.0069],
  ["THANK YOU FOR SHOPPING LOWES", 60, 0.2821, 0.7085, 0.4554, 0.0062],
  ["STORE: 2563 TERKINAL 6 03/24/26 11:44:31", 59, 0.1179, 0.9712, 0.7554, 0.0062],
]);

// Real lines (mats_09-02-25_home_depot): the purchase-date line is garbled
// ("68S 09/02, 25 0). ™M", confidence 0); the only date the rules can parse
// is the return-policy expiry under "POLICY … EXPIRES ON" (09/02 + 90 days).
// The model answered Home Depot, 2025-09-02, $43.74 — all right.
const HD_POLICY = real([
  ["Fel » - gL. uj \\", 48.7, 0.1479, 0.0069, 0.8499, 0.0265],
  ["ATE va", 24.6, 0.0988, 0.1158, 0.1201, 0.0092],
  ["WR", 13, 0.101, 0.1227, 0.2152, 0.0131],
  ["BRANT", 0, 0.0908, 0.12, 0.2269, 0.0438],
  ["NZ", 36.9, 0.0915, 0.1377, 0.1179, 0.0362],
  ["744%, ' A", 7.8, 0.0988, 0.1719, 0.2906, 0.0181],
  ["PA) i How doers", 53.7, 0.0944, 0.1573, 0.6625, 0.0631],
  ["\"& a aE = 3", 42.9, 0.1288, 0.2088, 0.7057, 0.0208],
  ["Aad) get more done", 55.7, 0.0893, 0.2138, 0.8053, 0.0369],
  ["02% Al i Cl", 53.1, 0.1332, 0.2988, 0.451, 0.0158],
  ["MELIN: AALHOR@HOMEDE OT K)", 30.7, 0.1127, 0.3185, 0.7731, 0.0162],
  ["639.3 B10 5 J (S452 / 4% MN", 35.9, 0.093, 0.3588, 0.806, 0.0154],
  ["SALE K |", 49.5, 0.0944, 0.3785, 0.9056, 0.0192],
  ["LOVEL <A> 9.9", 61.9, 0.4436, 0.4181, 0.4217, 0.015],
  ["FG IT CK CANVA LOVE |! |", 65, 0.1567, 0.4377, 0.8433, 0.0154],
  ["NL! Nge $s. 0", 23.4, 0.1567, 0.4569, 0.3836, 0.0181],
  ["4715409! 22 HUVEL KCB100 7", 38.1, 0.0952, 0.4769, 0.7899, 0.0158],
  ["CE 14 | K :", 85.4, 0.1574, 0.4965, 0.4619, 0.0158],
  ["TA", 73.4, 0.4736, 0.5635, 0.0534, 0.0273],
  ["KAKA (X AME»", 25.8, 0.0959, 0.5965, 0.418, 0.0162],
  ["AUTH CODE 862445 1.53472", 67.4, 0.0966, 0.6358, 0.4649, 0.0169],
  ["Chp Read", 70.6, 0.0959, 0.6562, 0.1808, 0.0181],
  ["AID AQOOCLOOZ%0 1 501 AM", 27.1, 0.0959, 0.675, 0.5051, 0.0165],
  ["P.0.#/J0B NAME:", 67.2, 0.0959, 0.7146, 0.4817, 0.0208],
  ["68S 09/02, 25 0). ™M", 0, 0.0578, 0.7342, 0.8902, 0.0296],
  ["EERE a Th", 26.9, 0.1918, 0.7523, 0.8082, 0.0469],
  ["All LEE —", 32.9, 0.2182, 0.7715, 0.7818, 0.0504],
  ["il {ELL 0 [", 40.3, 0.1918, 0.7888, 0.6259, 0.0354],
  ["6593 53 89002 19/002/72025 9299", 73, 0.1977, 0.8108, 0.5893, 0.0285],
  ["RETURN POLICY DEF INLI TONS", 37.7, 0.2387, 0.8604, 0.5073, 0.0208],
  ["POLICY ID DAYS POI ICY EXPIRES ON", 77, 0.1772, 0.8796, 0.7343, 0.0223],
  ["A 1 90 12/01/2025", 95.7, 0.1164, 0.9, 0.713, 0.0192],
]);
// Real lines (mats_08-11-25_the_home_depot): the purchase date prints
// 08/11/25 but OCR read "06/11/25" on a confidence-8 line; the policy
// expiry 11/09/2025 is 08/11 + 90 days. The model answered 2025-08-11.
const THD_0811 = real([
  ["TERE, fi, cabal 6 \\", 45.4, 0, 0, 0.6781, 0.0162],
  ["Babs A ia. a ad go", 30.9, 0.0822, 0.1158, 0.6669, 0.0315],
  ["PRL How doers", 71, 0, 0.1331, 0.7506, 0.0388],
  ["hu Sl get more done.", 71.4, 0, 0.1496, 0.9022, 0.0638],
  ["18292 COLLIER AVE LAKE ELS | 92530", 64.2, 0, 0.2504, 0.8977, 0.0265],
  ["(9913095-5055 MANAGER: WILLIAM \\", 43.4, 0, 0.2773, 0.8566, 0.0219],
  ["a3eLet 9129 06/11/25", 8.1, 0.0822, 0.3158, 0.6079, 0.0204],
  ["SALE Stit CHECKOUT", 53.9, 0.0814, 0.3354, 0.3547, 0.0162],
  ["019812771024 TAPE 100UFT <A>  106.9/", 39, 0.0807, 0.3735, 0.7931, 0.0231],
  ["EMPIRE 10uu YELLOW CAUTION TAPE", 60.5, 0.1419, 0.3927, 0.6512, 0.0181],
  ["810113520582 BAFLSHGRP20 <A> 3.48", 68.9, 0, 0.4054, 0.876, 0.0258],
  ["BOUYARMOP STRAWBERRY KIWI [.V. 2007", 77.1, 0.1419, 0.4319, 0.714, 0.0185],
  ["| 0000-999-867 BEV DEP 0.05 <A i= 0.05N", 68.2, 0, 0.4504, 0.8969, 0.0196],
  ["BEVERAGE BOTTLE OFF? 0 05", 64.4, 0.1412, 0.47, 0.4862, 0.0169],
  ["SUBTOTAL 14.50", 73.7, 0.4272, 0.5096, 0.4503, 0.0181],
  ["SALES TAX 1.26", 86.8, 0.4264, 0.5292, 0.4511, 0.0185],
  ["TOTAL $15.76", 93.2, 0.4279, 0.5485, 0.4496, 0.0192],
  ["HHHXXKKKNKNT417 MASTERCARD", 25.3, 0.0814, 0.5662, 0.5467, 0.0181],
  ["UsD$ 15.76", 67.7, 0.6721, 0.5885, 0.2061, 0.0185],
  ["~ AUTH CODE 845857/8517035 A", 52.1, 0.0508, 0.6046, 0.8275, 0.0219],
  ["Contactless Verified Gy PIN", 91.7, 0.0807, 0.6238, 0.8193, 0.0238],
  ["AID AOCGG000041010 MASTERCARD", 30.5, 0.0172, 0.6431, 0.8611, 0.0242],
  ["<i> - NON-DISCOUNTABLE ITEM", 52.8, 0.0605, 0.6754, 0.5683, 0.0323],
  ["LU ier TE", 5.2, 0.006, 0.7042, 0.3719, 0.0246],
  ["ES hE Es PM", 31.1, 0.0007, 0.7354, 0.9373, 0.0554],
  ["jl", 0, 0.1889, 0.8042, 0.0762, 0.025],
  ["fe ol 71172025 6753", 53.3, 0.1763, 0.825, 0.5967, 0.0335],
  ["RETURN POLICY DEFINITIONS", 60.2, 0.1673, 0.8558, 0.5639, 0.0335],
  ["| POLICY'ID ~ DAYS POLICY EXPIRES ON", 49.7, 0.0007, 0.8804, 0.8962, 0.0246],
  ["1 90 11/09/2025", 84.1, 0.0919, 0.8988, 0.7214, 0.0292],
]);

test("an AI total the OCR can't find, differing from a confident rules total, is a review-forcing warn", () => {
  const confident = draft({ amount: 187.38, amountConfidence: 0.8 });
  const flags = corroborate(ai("AMERICAN EXPRESS", "2026-03-13", 107.38), confident, AMEX);
  assert.deepEqual(flags, [
    {
      code: "total_suspect",
      severity: "warn",
      // Neutral: which reader said what — never a claim about what the receipt prints.
      message: "The AI read $107.38; the on-device reader found $187.38 — check the total.",
    },
  ]);
  assert.equal(forcesManualReview(flags), true);
  const atLine = draft({ amount: 187.38, amountConfidence: CORROBORATE_MIN_RULES_CONFIDENCE });
  assert.equal(corroborate(ai("X", "2026-03-13", 107.38), atLine, AMEX).length, 1, "the threshold itself counts");
});

test("a weak rules total is no evidence against the AI — a garbled total is why the assist ran", () => {
  // The real AMEX slip read its FUEL TOTAL line at OCR confidence 64: the
  // rules' 187.38 carries 0.55, and the model's 107.38 was the right answer.
  const ex = parseReceipt({ text: AMEX.map((l) => l.text).join("\n"), confidence: 60, lines: AMEX, words: [] });
  assert.equal(ex.amount.value, 187.38);
  assert.ok(ex.amount.confidence < CORROBORATE_MIN_RULES_CONFIDENCE, String(ex.amount.confidence));
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 107.38), ex, AMEX), []);
  // Real Home Depot: the rules could only scrape 2.25 out of garbled lines
  // (0.5); the model's $43.74 stands without a flag.
  const hd = parseReceipt({ text: HD_POLICY.map((l) => l.text).join("\n"), confidence: 50, lines: HD_POLICY, words: [] });
  assert.ok(hd.amount.confidence < CORROBORATE_MIN_RULES_CONFIDENCE, String(hd.amount.confidence));
  assert.ok(!corroborate(ai("Home Depot", "2025-09-02", 43.74), hd, HD_POLICY).some((f) => f.code === "total_suspect"));
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 107.38), draft({ amount: 187.38, amountConfidence: 0.74 }), AMEX), []);
});

test("an AI date the OCR can't find, differing from a clean rules date, is a review-forcing warn", () => {
  // A cleanly read, labeled "DATE: 03/24/26"; the model read 2024-03-26.
  const CLEAN = lines(["LOWE'S HOME CENTERS", "DATE: 03/24/26 11:44", "TOTAL: 329.00"]);
  const flags = corroborate(
    ai("LOWES", "2024-03-26", 329),
    draft({ date: "2026-03-24", dateConfidence: 0.8, amount: 329 }),
    CLEAN,
  );
  assert.deepEqual(flags, [
    {
      code: "date_suspect",
      severity: "warn",
      message: "The AI read 2024-03-26; the on-device reader found 2026-03-24 — check the date.",
    },
  ]);
  assert.equal(forcesManualReview(flags), true);
  assert.equal(CORROBORATE_MIN_RULES_DATE_CONFIDENCE, 0.8);
  // The real Lowe's slip prints the same date only on lines OCR read at
  // 17–59, and the rules pick the first (17): no evidence against the AI.
  // That receipt is still forced to review — by the two-year age check.
  assert.deepEqual(
    corroborate(ai("LOWES", "2024-03-26", 329), draft({ date: "2026-03-24", dateConfidence: 0.8, amount: 329 }), LOWES),
    [],
  );
  assert.ok(
    visionToExtraction({ vendor: "LOWES", date: "2024-03-26", amount: 329, tax: 0, category: "Materials" }).flags.some(
      (f) => f.code === "date_suspect",
    ),
  );
});

test("a last-resort rules date, or one on a garbled line, never contradicts the AI — even when unambiguous", () => {
  // An UNAMBIGUOUS policy expiry (14 > 12 → confidence 0.8, rank 3).
  const policy = lines(["THE HOME DEPOT", "POLICY ID DAYS POLICY EXPIRES ON", "A 1 90 12/14/2025", "TOTAL $43.74"]);
  const hd = parseReceipt({ text: policy.map((l) => l.text).join("\n"), confidence: 80, lines: policy, words: [] });
  assert.equal(hd.date.value, "2025-12-14");
  assert.ok(hd.date.confidence >= CORROBORATE_MIN_RULES_DATE_CONFIDENCE);
  assert.deepEqual(corroborate(ai("Home Depot", "2025-09-15", 43.74), hd, policy), []);
  // An unambiguous date on a line OCR read at 20.
  const garbled: OcrLine[] = lines(["SHELL", "08/23/25 12:21", "TOTAL 40.00"]).map((l, i) => (i === 1 ? { ...l, confidence: 20 } : l));
  assert.deepEqual(
    corroborate(ai("Shell", "2025-08-28", 40), draft({ date: "2025-08-23", dateConfidence: 0.8, amount: 40 }), garbled),
    [],
  );
  // The day/month swap still fires whatever the evidence.
  assert.equal(
    corroborate(ai("Shell", "2025-03-08", 40), draft({ date: "2025-08-03", dateConfidence: 0.65, amount: 40 }), garbled)[0]?.code,
    "date_suspect",
  );
});

test("a rules total the rules themselves question is no evidence against the AI's", () => {
  const L = lines(["SHELL", "SUBTOTAL 36.00", "TOTAL 39.20"]);
  const d = draft({ amount: 36, amountConfidence: 0.9 });
  assert.equal(corroborate(ai("Shell", "", 39.2), d, L).length, 0, "the AI total is printed");
  const doubted = { ...d, flags: [{ code: "total_suspect" as const, severity: "warn" as const, message: "window recovery" }] };
  assert.deepEqual(corroborate(ai("Shell", "", 41.5), doubted, L), []);
  assert.equal(corroborate(ai("Shell", "", 41.5), d, L)[0]?.code, "total_suspect");
});

test("an ambiguous, repaired or last-resort rules date is no evidence against the AI's", () => {
  // Real Home Depot: the rules could only parse the return-policy EXPIRY
  // (12/01/2025, ambiguous m/d: 0.65); the model's 2025-09-02 is the sale.
  const hd = parseReceipt({ text: HD_POLICY.map((l) => l.text).join("\n"), confidence: 50, lines: HD_POLICY, words: [] });
  assert.equal(hd.date.value, "2025-12-01");
  assert.ok(hd.date.confidence < CORROBORATE_MIN_RULES_DATE_CONFIDENCE, String(hd.date.confidence));
  assert.deepEqual(corroborate(ai("Home Depot", "2025-09-02", 43.74), hd, HD_POLICY), []);
  // Real Home Depot: OCR misread 08/11/25 as "06/11/25" (0.65); the model's
  // 2025-08-11 was right.
  const thd = parseReceipt({ text: THD_0811.map((l) => l.text).join("\n"), confidence: 50, lines: THD_0811, words: [] });
  assert.equal(thd.date.value, "2025-06-11");
  assert.deepEqual(corroborate(ai("The Home Depot", "2025-08-11", 15.76), thd, THD_0811), []);
});

test("an AI date that swaps the rules date's day and month is flagged whatever the rules' confidence", () => {
  // Ambiguous m/d dates are exactly where a model swaps day and month: the
  // real 0.65 read of "06/11/25" against an AI 2025-11-06.
  const thd = parseReceipt({ text: THD_0811.map((l) => l.text).join("\n"), confidence: 50, lines: THD_0811, words: [] });
  assert.ok(thd.date.confidence < CORROBORATE_MIN_RULES_DATE_CONFIDENCE);
  assert.deepEqual(corroborate(ai("The Home Depot", "2025-11-06", 15.76), thd, THD_0811), [
    {
      code: "date_suspect",
      severity: "warn",
      message: "The AI read 2025-11-06; the on-device reader found 2025-06-11 — check the day and month order.",
    },
  ]);
  // Only an exact swap in the same year counts.
  const weak = (date: string) => draft({ date, dateConfidence: 0.65, amount: 329 });
  assert.deepEqual(corroborate(ai("X", "2024-11-06", 329), weak("2025-06-11"), LOWES), []);
  assert.deepEqual(corroborate(ai("X", "2025-11-07", 329), weak("2025-06-11"), LOWES), []);
});

test("corroboration stays quiet when the OCR backs the AI, or has nothing to say", () => {
  const sure = (p: Parameters<typeof draft>[0]) => draft({ amountConfidence: 0.9, dateConfidence: 0.9, ...p });
  // The AI total is printed (the rules read a garbled 61): no flag.
  assert.deepEqual(corroborate(ai("MOBIL MART", "2026-04-21", 113.61), sure({ amount: 61 }), L), []);
  // Agreement, a missing rules value, or no lines at all: no flag.
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 187.38), sure({ amount: 187.38 }), AMEX), []);
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 107.38), sure({ amount: 0 }), AMEX), []);
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 107.38), sure({ amount: 187.38 }), []), []);
  // The rules had no date (AMEX): a date the AI alone read isn't contradicted.
  assert.deepEqual(corroborate(ai("X", "2026-03-13", 187.38), sure({ amount: 187.38 }), AMEX), []);
  // The dates agree, or the AI's is printed too — even as a day/month swap.
  assert.deepEqual(corroborate(ai("X", "2026-03-24", 329), sure({ date: "2026-03-24", amount: 329 }), LOWES), []);
  const both = lines(["SHOP", "06/11/25 PURCHASE", "11/06/25 PICKUP", "TOTAL 12.00"]);
  assert.deepEqual(corroborate(ai("X", "2025-11-06", 12), sure({ date: "2025-06-11", amount: 12 }), both), []);
});

test("settling anchors, puts corroboration flags first, and never throws away a billed answer", () => {
  const settled = settleAssistExtraction(
    ai("AMERICAN EXPRESS", "2026-03-13", 107.38),
    draft({ amount: 187.38, amountConfidence: 0.8 }),
    AMEX,
  );
  assert.equal(settled.flags[0]!.code, "total_suspect", "the review reason leads (the card shows flags[0])");
  assert.equal(settled.amount.value, 107.38, "values never change — the human decides");
  assert.equal(settled.amount.bbox, undefined);
  // The card network was blanked before anchoring (vetVisionVendor), and a
  // blank vendor never gets a box.
  assert.equal(settled.vendor.value, "");
  assert.equal(settled.vendor.bbox, undefined);

  // A poisoned draft makes both steps throw: the bare answer survives.
  const poisoned = new Proxy({} as Extraction, {
    get() {
      throw new Error("boom");
    },
  });
  const answer = ai("Shell", "2026-03-14", 43.2);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(settleAssistExtraction(answer, poisoned, L), answer);
  } finally {
    console.warn = warn;
  }
});

// ── The whole chain: vet, then anchor and corroborate ────────────────────────

// Every real OCR line of fuel_03-13-26_american_express, as the pipeline
// holds them (runVisionAssist gets the same lines and the rules draft).
const AMEX_FULL = real([
  ["5. Hg Springs hee", 51.6, 0.2741, 0.1312, 0.4332, 0.0238],
  ["Baring op gpg", 23.5, 0.3608, 0.1523, 0.2543, 0.0192],
  ["308 g, HIGHLAND SPRI", 68.6, 0.1662, 0.1988, 0.6506, 0.0277],
  ["SOBHy YOUSEF", 72.8, 0.169, 0.2177, 0.3963, 0.0231],
  ["KRARRK NHN 39", 0, 0.1705, 0.2365, 0.4233, 0.0238],
  ["BANNING , CA", 81.2, 0.1733, 0.255, 0.527, 0.0262],
  ["9222@", 24.1, 0.1747, 0.2738, 0.1676, 0.0146],
  ["83/13/2028 78883184", 72.3, 0.1776, 0.2927, 0.6236, 0.0254],
  ["05:31:99 AM", 72.6, 0.179, 0.3112, 0.3679, 0.0196],
  ["KEXRRRURR NY 285 7", 24.2, 0.1847, 0.3485, 0.4901, 0.0188],
  ["AM Express", 88.1, 0.1889, 0.3669, 0.3239, 0.0173],
  ["INVOICE 879212", 86.7, 0.1932, 0.3858, 0.4517, 0.0169],
  ["AUTH 8z925@", 61.7, 0.1875, 0.4042, 0.3551, 0.0146],
  ["PUMP# 14", 74.6, 0.1861, 0.4412, 0.7784, 0.0212],
  ["Regular 18.842G", 71.8, 0.1491, 0.4673, 0.7045, 0.0281],
  ["PRICE/GAL . $5.899", 47.1, 0.1747, 0.4935, 0.6804, 0.0208],
  ["= FUEL TOTAL $ 187.38", 64.4, 0.1108, 0.5277, 0.7457, 0.0215],
  ["TS TOTAL S & pr", 0, 0.0227, 0.5742, 0.8224, 0.0254],
  ["CREDIT $ 187.38", 79.6, 0.1634, 0.6173, 0.6761, 0.0169],
  ["Dustostr-activated Pacchse Capture", 32.9, 0.1619, 0.6588, 0.5909, 0.0281],
  ["Site #: 69%88RRR0TS4Y3 :", 9.3, 0.1619, 0.6858, 0.7955, 0.0169],
  ["Shaft Number : :", 62.1, 0.1605, 0.7038, 0.4773, 0.0208],
  ["Sequence Number 57823 Gg", 66.7, 0.1605, 0.7219, 0.5256, 0.0196],
  ["Contactless N", 60.6, 0.1591, 0.7396, 0.5781, 0.0181],
  ["AMERICAN EXPRESS", 67.2, 0.1605, 0.7585, 0.2699, 0.0115],
  ["Kode: Issuer", 55.7, 0.1577, 0.7769, 0.2031, 0.0112],
  ["AID: ABEREABA256188A1", 29.9, 0.1591, 0.795, 0.3466, 0.0108],
  ["TVR: 6688682860", 59.4, 0.1577, 0.8131, 0.2543, 0.0108],
]);

test("the whole assist chain on the real AMERICAN EXPRESS slip: vetted blank, no box, review forced", (t) => {
  // The slip is dated 2026-03-13: pin the clock so the "more than two years
  // old" date_suspect (dateFlags) can't join the exact flag list below.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 23) });
  const ex = parseReceipt({
    text: AMEX_FULL.map((l) => l.text).join("\n"),
    confidence: 60,
    lines: AMEX_FULL,
    words: [],
  });
  const fields = { vendor: "AMERICAN EXPRESS", date: "2026-03-13", amount: 107.38, tax: 0, category: "Fuel" };
  // The order runVisionAssist uses: visionToExtraction vets the vendor with
  // the draft + lines, and only then does settle anchor and corroborate.
  const settled = settleAssistExtraction(visionToExtraction(fields, { draft: ex, lines: AMEX_FULL }), ex, AMEX_FULL);
  assert.equal(settled.vendor.value, "", "the card network never survives as the vendor");
  assert.equal(settled.vendor.bbox, undefined, "a blank vendor is never outlined");
  // No total_suspect: the rules read the FUEL TOTAL line weakly (OCR 64 →
  // 0.55, under CORROBORATE_MIN_RULES_CONFIDENCE), and the model's 107.38 was
  // the right total — the blanked vendor alone forces the review.
  assert.ok(ex.amount.confidence < CORROBORATE_MIN_RULES_CONFIDENCE, String(ex.amount.confidence));
  assert.deepEqual(
    settled.flags.filter((f) => f.severity === "warn").map((f) => f.code),
    ["vendor_unclear"],
    JSON.stringify(settled.flags),
  );
  assert.match(settled.flags.find((f) => f.code === "vendor_unclear")!.message, /"AMERICAN EXPRESS"/);
  assert.equal(forcesManualReview(settled.flags), true);
  assert.equal(settled.amount.value, 107.38, "values are the human's call");
  assert.equal(settled.category.value, "Fuel");
});

test("a corroboration flag supersedes the answer's own flag of the same code (one date_suspect, not two)", () => {
  // Real Lowe's: the model read 2024-03-26 — over two years old AND not what
  // the on-device reader found (03/24/26). The corroboration message names both reads.
  const answer = visionToExtraction({ vendor: "LOWES", date: "2024-03-26", amount: 329, tax: 0, category: "Materials" });
  assert.ok(answer.flags.some((f) => f.code === "date_suspect"), "the age check fired");
  const CLEAN = lines(["LOWE'S HOME CENTERS", "DATE: 03/24/26 11:44", "TOTAL: 329.00"]);
  const settled = settleAssistExtraction(answer, draft({ date: "2026-03-24", dateConfidence: 0.8, amount: 329 }), CLEAN);
  const dates = settled.flags.filter((f) => f.code === "date_suspect");
  assert.equal(dates.length, 1, JSON.stringify(settled.flags));
  assert.match(dates[0]!.message, /the on-device reader found 2026-03-24/);
  assert.equal(settled.flags[0]!.code, "date_suspect");
});

// ── Provenance ───────────────────────────────────────────────────────────────

const cfg = (patch: Parameters<typeof mergeVisionConfig>[1] = {}) => mergeVisionConfig(defaultVisionConfig(""), patch);

test("where the model ran is recorded as a kind, never the URL", () => {
  assert.equal(assistHost("http://localhost:11434/v1"), "this-device");
  assert.equal(assistHost("http://127.0.0.1:1234/v1"), "this-device");
  assert.equal(assistHost("http://[::1]:8080/v1"), "this-device");
  assert.equal(assistHost("http://10.0.0.167:1234/v1"), "private-network");
  assert.equal(assistHost("http://192.168.1.20:8000/v1"), "private-network");
  assert.equal(assistHost("http://172.20.0.2/v1"), "private-network");
  assert.equal(assistHost("http://100.101.102.103:8000/v1"), "private-network");
  assert.equal(assistHost("http://[fd12:3456::1]:8000/v1"), "private-network");
  assert.equal(assistHost("http://gpu-box:8000/v1"), "private-network");
  assert.equal(assistHost("http://studio.local:1234/v1"), "private-network");
  assert.equal(assistHost("http://172.32.0.2/v1"), "internet");
  assert.equal(assistHost("https://llm.example.com/v1"), "internet");
  assert.equal(assistHost("https://openrouter.ai/api/v1"), "internet");
  assert.equal(assistHost("not a url"), "internet");
});

test("whose credential the call used is recorded as a kind, never the key", () => {
  const free = resolveEndpoint(cfg({ cloud: { provider: "openrouter", model: "openrouter/free", apiKey: "" } }), "sk-built");
  assert.equal(assistKeySource(free, "sk-built"), "builtin");
  const own = resolveEndpoint(cfg({ cloud: { provider: "openrouter", model: "openrouter/free", apiKey: "sk-mine" } }), "sk-built");
  assert.equal(assistKeySource(own, "sk-built"), "own");
  assert.equal(assistKeySource({ ...free, apiKey: "jwt", viaProxy: true }, "sk-built"), "account");
  const keyless = resolveEndpoint(cfg({ backend: "local" }), "");
  assert.equal(assistKeySource(keyless, ""), "none");
  const lan = resolveEndpoint(cfg({ backend: "selfhosted", selfhosted: { url: "http://10.0.0.167:1234/v1", model: "m", apiKey: "t0k" } }), "");
  assert.equal(assistKeySource(lan, ""), "own");
  // A keyless build: an empty key is never "the built-in key".
  assert.equal(assistKeySource(resolveEndpoint(cfg(), ""), ""), "none");
});

test("the provenance record keeps the proxy downgrade, calls and the rules read — and neither URL nor key", () => {
  const lan = resolveEndpoint(
    cfg({ backend: "selfhosted", selfhosted: { url: "http://10.0.0.167:1234/v1", model: "bonsai-27b", apiKey: "sk-secret-123" } }),
    "",
  );
  const rules = draft({ vendor: "WHOLESALE", date: "2025-01-01", amount: 38.05 });
  const p = assistProvenance({
    endpoint: lan,
    requested: "oneshot",
    strategy: "oneshot",
    result: { model: "bonsai-27b", servedModel: "bonsai-27b", calls: 1, rawText: '{"vendor":"Costco"}' },
    draft: rules,
  });
  assert.deepEqual(p, {
    backend: "selfhosted",
    provider: "Self-hosted",
    model: "bonsai-27b",
    host: "private-network",
    keySource: "own",
    requestedStrategy: "oneshot",
    strategy: "oneshot",
    viaProxy: false,
    calls: 1,
    rawAnswer: '{"vendor":"Costco"}',
    rules: { vendor: "WHOLESALE", date: "2025-01-01", amount: 38.05, tax: 1.5, category: "Fuel", confidence: 0.66 },
  });
  assert.equal("servedModel" in p, false, "a served model equal to the configured one is not repeated");
  const json = JSON.stringify(p);
  for (const secret of ["10.0.0.167", "1234", "sk-secret-123"]) assert.equal(json.includes(secret), false, secret);

  // Signed in: the proxy forced one-shot and its bearer is the session token.
  const proxied = {
    ...resolveEndpoint(cfg({ cloud: { provider: "openrouter", model: "openrouter/free", apiKey: "" } }), "sk-built"),
    baseUrl: "https://proj.supabase.co/functions/v1/ai-extract",
    apiKey: "eyJ.session.token",
    viaProxy: true,
  };
  const viaAccount = assistProvenance({
    endpoint: proxied,
    requested: "agentic",
    strategy: "oneshot",
    result: { model: "openrouter/free", servedModel: "qwen/qwen2.5-vl-72b-instruct:free", calls: 1, rawText: "{}" },
    draft: rules,
    builtIn: "sk-built",
  });
  assert.equal(viaAccount.requestedStrategy, "agentic");
  assert.equal(viaAccount.strategy, "oneshot");
  assert.equal(viaAccount.viaProxy, true);
  assert.equal(viaAccount.keySource, "account");
  assert.equal(viaAccount.host, "internet");
  assert.equal(viaAccount.servedModel, "qwen/qwen2.5-vl-72b-instruct:free");
  const pj = JSON.stringify(viaAccount);
  assert.equal(pj.includes("eyJ.session.token") || pj.includes("supabase.co") || pj.includes("sk-built"), false);
});

test("the raw answer keeps its tail: the submit line and a reasoning JSON come last", () => {
  const long = "x".repeat(10_000) + '{"amount":1}';
  const capped = tailCap(long);
  assert.equal(capped.length, ASSIST_RAW_MAX + 1);
  assert.ok(capped.startsWith("…"));
  assert.ok(capped.endsWith('{"amount":1}'));
  assert.equal(tailCap("short"), "short");
  const p = assistProvenance({
    endpoint: resolveEndpoint(cfg({ backend: "local" }), ""),
    requested: "oneshot",
    strategy: "oneshot",
    result: { model: "m", calls: 1, rawText: long },
    draft: draft({}),
  });
  assert.equal(p.rawAnswer, capped);
});

// A lone UTF-16 surrogate in the stored answer rides the sync payload, and
// Postgres jsonb refuses it ("Unicode low surrogate must follow a high
// surrogate") — the whole receipts upsert fails, on every push after.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("the raw answer is always well-formed text: the cut never splits an emoji, a lone surrogate is replaced", () => {
  // "👍" straddles the cut: the last ASSIST_RAW_MAX units start on its low half.
  const straddle = "Reasoning… 👍" + "x".repeat(ASSIST_RAW_MAX - 1);
  const capped = tailCap(straddle);
  assert.ok(!LONE_SURROGATE.test(capped), "no half of the emoji survives the cut");
  assert.equal(capped, "…" + "x".repeat(ASSIST_RAW_MAX - 1));
  assert.ok(!/\\ud[89a-f]/i.test(JSON.stringify({ rawAnswer: capped })), "stringifies without a surrogate escape");
  // A whole emoji is kept, at the cut or anywhere else.
  const whole = "😊" + "x".repeat(ASSIST_RAW_MAX - 2);
  assert.equal(tailCap("pad" + whole), "…" + whole);
  assert.equal(tailCap("ok 😊"), "ok 😊");
  // The model's own lone surrogate (a broken "\ud83d" escape) — short or long.
  assert.equal(tailCap('{"vendor":"Caf\uD83D"}'), '{"vendor":"Caf\uFFFD"}');
  assert.equal(wellFormed("a\uDC4Db\uD83D"), "a\uFFFDb\uFFFD");
  assert.equal(wellFormed("a😊b"), "a😊b");
  const p = assistProvenance({
    endpoint: resolveEndpoint(cfg({ backend: "local" }), ""),
    requested: "oneshot",
    strategy: "oneshot",
    result: { model: "m", calls: 1, rawText: straddle },
    draft: draft({}),
  });
  assert.ok(!LONE_SURROGATE.test(p.rawAnswer));
});

const PROV: AssistProvenance = {
  backend: "selfhosted",
  provider: "Self-hosted",
  model: "bonsai-27b",
  host: "private-network",
  keySource: "none",
  requestedStrategy: "oneshot",
  strategy: "oneshot",
  viaProxy: false,
  calls: 1,
  rawAnswer: "{}",
  rules: { vendor: "", date: "", amount: 0, tax: 0, category: "Other", confidence: 0.5 },
};

test("methodDetail always names the strategy (absence no longer implies one-shot)", () => {
  assert.equal(assistMethodDetail(PROV), "Self-hosted · bonsai-27b · one-shot");
  assert.equal(
    assistMethodDetail({ ...PROV, strategy: "agentic", requestedStrategy: "agentic", calls: 3 }),
    "Self-hosted · bonsai-27b · agentic, 3 calls",
  );
  assert.equal(
    assistMethodDetail({ ...PROV, strategy: "agentic", requestedStrategy: "agentic", calls: 1 }),
    "Self-hosted · bonsai-27b · agentic, 1 call",
  );
  assert.equal(
    assistMethodDetail({
      ...PROV,
      backend: "cloud",
      provider: "OpenRouter",
      model: "openrouter/free",
      servedModel: "qwen/x:free",
      requestedStrategy: "agentic",
      viaProxy: true,
    }),
    "OpenRouter · openrouter/free → qwen/x:free · one-shot (agentic requested) · via your account",
  );
});

test("rows stored before provenance: detected, and their old methodDetail parsed", () => {
  assert.equal(isLegacyAiRead({ methodUsed: "paid" }), true);
  assert.equal(isLegacyAiRead({ methodUsed: "paid", assist: PROV }), false);
  assert.equal(isLegacyAiRead({ methodUsed: "rules" }), false);
  assert.deepEqual(parseLegacyMethod("Self-hosted · bonsai-27b"), {
    provider: "Self-hosted",
    model: "bonsai-27b",
    strategy: "oneshot",
  });
  assert.deepEqual(parseLegacyMethod("OpenRouter · openrouter/free · agentic"), {
    provider: "OpenRouter",
    model: "openrouter/free",
    strategy: "agentic",
  });
  assert.deepEqual(parseLegacyMethod(undefined), { provider: "", model: "", strategy: "oneshot" });
});

// ── The image-hash cache ─────────────────────────────────────────────────────

test("the hash cache never lends an AI row's answer as if it were printed", () => {
  const ocrLines = [
    { text: "COSTCO", confidence: 80, bbox: { x: 0, y: 0, w: 1, h: 0.1 }, words: [] },
    { text: "TOTAL 9.99", confidence: 60, bbox: { x: 0, y: 0.5, w: 1, h: 0.1 }, words: [] },
  ];
  // A rules row lends its OCR text and lines (and its stored confidence).
  assert.deepEqual(reusableOcr({ methodUsed: "rules", ocrText: "COSTCO\n\nTOTAL 9.99", ocrLines, confidence: 0.77 }), {
    text: "COSTCO\n\nTOTAL 9.99",
    lines: ocrLines,
    confidence: 77,
  });
  assert.deepEqual(reusableOcr({ methodUsed: "rules", ocrText: "TOTAL 1.00", confidence: 0.5 })?.lines, []);
  assert.equal(reusableOcr({ methodUsed: "rules", ocrText: "", ocrLines, confidence: 0.9 }), null);
  // An AI row (legacy or not) lends its LINES, rebuilt as text, with their
  // mean OCR confidence — never its ocrText or the model's 0.92.
  const json = '{"vendor": "Costco Wholesale", "amount": 9.99}';
  for (const assist of [undefined, PROV]) {
    const lent = reusableOcr({ methodUsed: "paid", ocrText: json, ocrLines, confidence: 0.92, ...(assist ? { assist } : {}) });
    assert.deepEqual(lent, { text: "COSTCO\nTOTAL 9.99", lines: ocrLines, confidence: 70 });
  }
  assert.equal(reusableOcr({ methodUsed: "paid", ocrText: json, confidence: 0.92 }), null, "no lines, nothing honest to lend");
});

test("an arithmetic-verified rules total still contradicts a wrong AI total; footing's window guess doesn't", () => {
  // The printed-sum correction: TOTAL misread as 2638.08, and footing finds
  // the printed 638.08 = SUBTOTAL + TAX — verified (info total_mismatch).
  const L = lines(["COSTCO WHOLESALE", "SUBTOTAL 600.00", "TAX 38.08", "TOTAL 2638.08", "VISA 638.08"]);
  const d = parseReceipt({ text: L.map((l) => l.text).join("\n"), confidence: 85, lines: L, words: [] });
  assert.equal(d.amount.value, 638.08);
  assert.ok(d.flags.some((f) => f.code === "total_mismatch" && f.severity === "info"), JSON.stringify(d.flags));
  // A model digit transposition printed nowhere must not ship unreviewed.
  assert.equal(corroborate(ai("Costco", "", 683.08), d, L)[0]?.code, "total_suspect");

  // Footing's window recovery is a GUESS (the largest printed value in the
  // subtotal window) — no evidence against the AI.
  const guess = {
    ...d,
    amount: { value: 612.5, confidence: 0.9 },
    flags: [{ code: "total_mismatch" as const, severity: "info" as const, message: `Amount corrected: 9612.50 is far outside subtotal (600.00) — ${WINDOW_RECOVERY_NOTE}.` }],
  };
  assert.deepEqual(corroborate(ai("Costco", "", 683.08), guess, L), []);
});

test("the stored raw answer never carries a NUL", () => {
  const capped = tailCap('{"vendor":"A\u0000B"}');
  assert.equal(capped.includes("\u0000"), false);
  assert.equal(capped, '{"vendor":"AB"}');
});
