// Legacy AI reads from the owner's 2026-09 upload (the tuning bundle's
// extraction.json): rows the self-hosted assist read BEFORE provenance.ts
// anchored answers on the OCR lines — `methodUsed: "paid"`, no `assist`, no
// boxes on the model's values, and `ocrText` holding the model's JSON answer.
// Ids, fields and the stored OCR lines (text, confidence, box) are verbatim —
// garbles and all; boxes are rounded to 4 decimals, and nothing here carries
// a card number. `createdAt` is the row's position in the 67-receipt upload
// (upload order). tests/recheck.test.ts heals them from this stored data.

import type { Field, Flag, OcrLine, ReceiptStatus } from "../../src/types.ts";

export interface LegacyAiRow {
  id: string;
  createdAt: number;
  fileName: string;
  originalFileName: string;
  status: ReceiptStatus;
  approved: boolean;
  reviewRequired: boolean;
  /** The pre-provenance `methodDetail` shape: "provider · model". */
  methodDetail: string;
  /** The MODEL's answer — what every assist wrote here before provenance. */
  ocrText: string;
  vendor: Field<string>;
  date: Field<string>;
  amount: Field<number>;
  tax: Field<number>;
  category: Field<"Fuel" | "Other">;
  confidence: number;
  flags: Flag[];
  ocrLines: OcrLine[];
}

type Raw = [text: string, confidence: number, x: number, y: number, w: number, h: number];
const lines = (rows: Raw[]): OcrLine[] =>
  rows.map(([text, confidence, x, y, w, h]) => ({ text, confidence, bbox: { x, y, w, h }, words: [] }));

// The PIP PRINTING card slip (page 7 of the scan PDF): the vendor line is
// printed; the date ("12/1225") and the amount (a blank AMOUNT line) are not.
export const pipSlip: LegacyAiRow = {
  id: "rcpt_435f0b3d-36f9-492a-a67f-40801ead5f21",
  createdAt: 43,
  fileName: "misc_12-12-25_pip_printing_riverside.jpg",
  originalFileName: "Scan from 2026-07-16 03_04_02 PM.pdf (page 7 of 27)",
  status: "done",
  approved: false,
  reviewRequired: false,
  methodDetail: "Self-hosted · bonsai-27b",
  ocrText: "{\"vendor\": \"PIP PRINTING RIVERSIDE\", \"date\": \"2025-12-12\", \"amount\": 28.5, \"tax\": 0, \"category\": \"Other\"}",
  vendor: { value: "PIP PRINTING RIVERSIDE", confidence: 0.9 },
  date: { value: "2025-12-12", confidence: 0.9 },
  amount: { value: 28.5, confidence: 0.92 },
  tax: { value: 0, confidence: 0.85 },
  category: { value: "Other", confidence: 0.9 },
  confidence: 0.92,
  flags: [
    { code: "stale_date", severity: "info", message: "Receipt is over 120 days old." },
  ],
  ocrLines: lines([
    ["PIP PRINTING RIVERSIDE", 94.1833, 0.1791, 0.0858, 0.5782, 0.0181],
    ["| 4093 MARKET ST", 93.2419, 0, 0.1142, 0.6818, 0.0177],
    ["RIVERSIDE, CA. 92501", 96.5419, 0.2125, 0.1419, 0.5113, 0.0204],
    ["951-682-2005", 96.3793, 0.3333, 0.1715, 0.2686, 0.0165],
    ["ALE", 54.329, 0.4002, 0.2292, 0.1629, 0.0192],
    ["|", 83.979, 0, 0.2792, 0.0011, 0.0208],
    ["REF#: 00000003", 82.9908, 0.5426, 0.3146, 0.356, 0.0165],
    ["Batch #. 252", 74.8839, 0, 0.3385, 0.3463, 0.0242],
    ["12/1225 10:38:47", 59.6613, 0.0399, 0.3696, 0.8587, 0.0185],
    ["APPR CODE: 05439D SR", 61.8576, 0, 0.3981, 0.6839, 0.0177],
    ["ENCRYPTED BY ELAVON J", 84.489, 0.0378, 0.4265, 0.7238, 0.0238],
    ["Trace: 3 A", 93.5017, 0.0388, 0.4531, 0.8015, 0.0269],
    ["VISA ;", 32.1964, 0.0399, 0.4831, 0.7066, 0.0254],
    ["Ta 10269 'd", 0, 0.0431, 0.5119, 0.5361, 0.0235],
    ["AMOUNT J", 58.1702, 0, 0.5408, 0.8986, 0.0262],
    ["A |", 64.9426, 0, 0.5785, 0.3592, 0.0288],
    ["Dr -", 45.8138, 0, 0.6123, 0.2654, 0.0323],
    ["“7 APPROVED", 51.6398, 0.0895, 0.6477, 0.5836, 0.0262],
    ["CHASE VISA", 93.0745, 0.0367, 0.7677, 0.3064, 0.0165],
    ["“AID: A0000000031010", 67.2398, 0, 0.7969, 0.5016, 0.0169],
    ["\"TVR: 00 00 00 00 00", 89.2998, 0, 0.8262, 0.5717, 0.0173],
    ["THANK YOU", 90.8632, 0.3269, 0.8846, 0.288, 0.0169],
    ["CUSTOM_R  OPY", 22.1369, 0.2567, 0.9738, 0.425, 0.0188],
  ]),
};

// The paper scan of the $83.44 Chevron fill-up (page 14): the model's
// "Chevron Station Inc.", the date and the total are all printed.
export const chevronScanMar02: LegacyAiRow = {
  id: "rcpt_78095937-e28b-49ee-bd5c-24aacfca0455",
  createdAt: 50,
  fileName: "fuel_03-02-26_chevron_station_inc.jpg",
  originalFileName: "Scan from 2026-07-16 03_04_02 PM.pdf (page 14 of 27)",
  status: "done",
  approved: false,
  reviewRequired: false,
  methodDetail: "Self-hosted · bonsai-27b",
  ocrText: "{\"vendor\": \"Chevron Station Inc.\", \"date\": \"2026-03-02\", \"amount\": 83.44, \"tax\": 0, \"category\": \"Fuel\"}",
  vendor: { value: "Chevron Station Inc.", confidence: 0.9 },
  date: { value: "2026-03-02", confidence: 0.9 },
  amount: { value: 83.44, confidence: 0.92 },
  tax: { value: 0, confidence: 0.85 },
  category: { value: "Fuel", confidence: 0.9 },
  confidence: 0.92,
  flags: [
    { code: "stale_date", severity: "info", message: "Receipt is over 120 days old." },
  ],
  ocrLines: lines([
    ["0 La Slerra Ave,", 90.6853, 0.2604, 0.1151, 0.5289, 0.0186],
    ["3390 erSide CA 93463", 38.4198, 0.1586, 0.1194, 0.6412, 0.0316],
    ["3390 La Slerra Ave.", 92.3999, 0.0891, 0.1827, 0.6343, 0.0198],
    ["chevron Station Inc.", 91.4644, 0.0891, 0.1993, 0.6701, 0.0198],
    ["00200734", 96.7855, 0.0891, 0.2179, 0.265, 0.0214],
    ["Riverside, CA", 95.8363, 0.088, 0.2353, 0.4363, 0.0182],
    ["03/02/2026 694565975", 95.2026, 0.0891, 0.2835, 0.9109, 0.021],
    ["08:42:10 AM", 95.749, 0.0891, 0.3053, 0.3681, 0.017],
    ["$AGARRANE KERIO", 0, 0.0914, 0.3393, 0.5359, 0.0364],
    ["INVOICE 0000045952", 94.469, 0.0972, 0.3745, 0.6019, 0.0186],
    ["AUTH 104740 |", 93.2304, 0.0938, 0.3922, 0.9062, 0.0182],
    ["Bis ID: chevron0020-073", 62.1533, 0.0938, 0.4096, 0.816, 0.0356],
    ["AmericanExpress Credit", 91.8583, 0.0949, 0.4365, 0.9051, 0.0265],
    ["PUMP# 16", 69.7504, 0.0961, 0.4713, 0.9039, 0.0273],
    ["UNLEAD REG 18.7136", 85.5149, 0.0984, 0.5144, 0.8079, 0.0174],
    ["PRICE/GAL $4. 459", 15.8335, 0.0984, 0.5318, 0.8079, 0.0194],
    ["~_ DISCOUNTS BEF |", 73.8783, 0.0231, 0.5662, 0.9769, 0.0186],
    ["CHEURON/GAL $-0.500", 83.3873, 0.1111, 0.6006, 0.794, 0.0237],
    ["FUEL TOTAL $¢ 83.44", 68.0622, 0.1076, 0.6342, 0.8009, 0.0245],
    ["Totala= § 83.44 |", 53.2103, 0.375, 0.6979, 0.6238, 0.0308],
    ["~~ CREDIT § 83.44 |", 62.3833, 0, 0.7386, 0.9988, 0.0245],
    ["E YOUR CHEVRON |", 55.9512, 0, 0.7703, 0.8738, 0.0395],
    ["~~ REWARDS AMOU", 55.513, 0.0127, 0.8078, 0.9861, 0.021],
    [": RTT is 5", 35.5618, 0.0174, 0.8122, 0.9815, 0.0506],
    ["BAUATARLE \"EVAR |", 19.5055, 0.0093, 0.847, 0.9896, 0.0376],
    ["| Thank you for :", 88.7449, 0, 0.9, 0.9988, 0.0312],
    ["i “on 4", 63.1057, 0.4051, 0.9284, 0.5938, 0.0119],
    ["Beaansns “lopy |", 0, 0.2245, 0.9296, 0.7743, 0.0316],
    ["E", 14.6595, 0.9803, 0.966, 0.0127, 0.0083],
    ["i", 46.906, 0.9792, 0.9751, 0.0185, 0.0142],
  ]),
};

// MOBIL MART, APPROVED, with a human-typed date whose box was drawn by hand
// (edited + manualBox); the model's $85.25 is printed nowhere (the slip reads
// "CREP $85.75").
export const mobilJan29Approved: LegacyAiRow = {
  id: "rcpt_ec5ed17e-0799-4b15-ab1b-5a01568a1ab6",
  createdAt: 54,
  fileName: "fuel_01-29-26_mobil_mart.jpg",
  originalFileName: "Scan from 2026-07-16 03_04_02 PM.pdf (page 18 of 27)",
  status: "done",
  approved: true,
  reviewRequired: false,
  methodDetail: "Self-hosted · bonsai-27b",
  ocrText: "{\"vendor\": \"MOBIL MART\", \"date\": \"1/29/2024\", \"amount\": 85.25, \"tax\": 0, \"category\": \"Fuel\"}",
  vendor: { value: "MOBIL MART", confidence: 1, bbox: { x: 0.3877, y: 0.1415, w: 0.3705, h: 0.0185 } },
  date: { value: "2026-01-29", confidence: 1, edited: true, bbox: { x: 0.3113, y: 0.2693, w: 0.2211, h: 0.0199 }, manualBox: true },
  amount: { value: 85.25, confidence: 1 },
  tax: { value: 0, confidence: 0.85 },
  category: { value: "Fuel", confidence: 1 },
  confidence: 0.7,
  flags: [],
  ocrLines: lines([
    ["WELCOME TO", 85.0809, 0.3202, 0.1231, 0.3306, 0.0173],
    ["MOBIL :", 56.0717, 0.3877, 0.1415, 0.5187, 0.0185],
    ["MOBIL MARI", 89.2609, 0.3191, 0.1588, 0.3295, 0.0219],
    ["1200 N St College", 92.9114, 0.1881, 0.1773, 0.5676, 0.02],
    ["Analicim CA", 84.6912, 0.3212, 0.1954, 0.3326, 0.0196],
    ["92806", 77.4425, 0.3877, 0.215, 0.1622, 0.0177],
    ["DATE 1724 ARGH 52", 41.5487, 0.1476, 0.2623, 0.578, 0.0285],
    ["TRANKGO3E", 3.8778, 0.1497, 0.2904, 0.2973, 0.0185],
    ["PUMPE 03 Sais", 61.0352, 0.1466, 0.3088, 0.6476, 0.0188],
    ["SERVICE LEKEC Te", 3.7155, 0.1455, 0.3215, 0.6435, 0.0431],
    ["si fpgildl", 0, 0.395, 0.3446, 0.3004, 0.0173],
    ["GALLONS: 18.4530", 50.438, 0.1445, 0.3573, 0.6996, 0.0258],
    ["c GPRICE/GE $4 57", 17.4256, 0.0686, 0.3765, 0.7755, 0.025],
    ["EEL SALES... |", 18.6411, 0.1414, 0.3973, 0.6975, 0.0227],
    ["CREP $85.75", 43.6833, 0.0717, 0.4162, 0.7651, 0.0292],
    [": Usngsy. 29", 39.3309, 0.0021, 0.4754, 0.4407, 0.0304],
    ["XXX XAX KXAN K(/", 3.7734, 0.1403, 0.4927, 0.5478, 0.0165],
    ["Entry: Chip Read", 95.5384, 0.1383, 0.5115, 0.5489, 0.0223],
    ["AppName: MASTERCAKD", 77.6124, 0.1393, 0.5288, 0.6497, 0.0235],
    ["AuthNet: MASTERCD", 50.6105, 0.1403, 0.5481, 0.579, 0.0208],
    ["MODE: Issuer", 90.245, 0.1403, 0.5692, 0.4044, 0.0185],
    ["ALD: A0000000041010", 71.8361, 0.1424, 0.5862, 0.6663, 0.0227],
    ["Auth #: 10214P b", 70.0069, 0.1424, 0.605, 0.6861, 0.02],
    ["si Resp. Code: 000:", 4.0628, 0.0364, 0.6242, 0.8399, 0.0246],
    ["BRI", 31.8199, 0.1414, 0.6431, 0.578, 0.0388],
    ["SL ILVO. “oR § :", 0, 0.0281, 0.6681, 0.6476, 0.0185],
    ["Seb A165E", 0, 0.2204, 0.6996, 0.4751, 0.0308],
    ["E", 0, 0.4719, 0.8004, 0.2422, 0.0369],
    ["THANK 100", 66.9951, 0.317, 0.8454, 0.3222, 0.0331],
    ["AVE A KifH DAY", 66.2239, 0.2588, 0.8735, 0.4647, 0.0269],
  ]),
};
