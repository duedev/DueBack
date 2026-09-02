#!/usr/bin/env python3
"""Export the original local app's vendor database into src/data/vendorDb.extra.json.

Reads ``vendor_db.py`` from the sibling Reimbursements repo (path via
``--source``, default ``../Reimbursements/vendor_db.py``) and emits the brands
as JSON in this app's taxonomy. The TS matcher (src/config/vendors.ts) merges
this file under its own curated table — curated entries win on name conflicts,
so this export only *adds* breadth (~300 brands) and slogans.

Run once when the source DB changes, then commit the regenerated JSON:

    python3 scripts/export_vendor_db.py
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "src" / "data" / "vendorDb.extra.json"

# fuel/mats/misc → app taxonomy. "misc" brands are refined by name/alias
# keywords below; anything unrecognized stays "Other" (naming the brand is
# already the win — category can be corrected in review).
CATEGORY_BASE = {"fuel": "Fuel", "mats": "Materials", "misc": "Other"}

# Brands whose names carry no category word at all. Mirrors the curated
# entries in src/config/vendors.ts KNOWN_VENDORS (which win at merge time
# anyway) so a regenerated JSON agrees with the curated table instead of
# fighting it. Keep the two in sync when adding a brand to either.
NAME_OVERRIDES: dict[str, str] = {
    **{
        n: "Meals"
        for n in (
            "Chick-fil-A", "Arby's", "Five Guys", "Jack in the Box", "Popeyes",
            "Whataburger", "Cracker Barrel", "Red Lobster", "Cheesecake Factory",
            "Panda Express", "Papa John's", "Little Caesars", "Raising Cane's",
            "Shake Shack", "Sonic Drive-In", "Tim Hortons", "Wingstop", "Zaxby's",
            "Jimmy John's", "Jersey Mike's", "Culver's", "Hardee's", "Carl's Jr.",
            "Bojangles", "Dutch Bros", "Qdoba", "Moe's Southwest", "Trader Joe's",
        )
    },
    **{
        n: "Lodging"
        for n in ("DoubleTree", "Wyndham", "Super 8", "Extended Stay America", "Vrbo")
    },
    **{
        n: "Utilities & Phone"
        for n in ("Boost Mobile", "Cricket Wireless", "MetroPCS", "Sprint")
    },
    **{n: "Software & Subscriptions" for n in ("Netflix", "Spotify")},
    "JetBlue": "Travel",
}

# Entertainment left with the "Meals & Entertainment" rename: theatres and
# cinemas are Other, like every other recognized-but-unbucketed merchant.
MISC_REFINE: list[tuple[str, re.Pattern[str]]] = [
    ("Lodging", re.compile(r"\b(hotel|hotels|inn|suites|resort|lodge|motel)\b", re.I)),
    # Matched per alias (not against the joined string): a "$"-anchored pattern
    # over a set join depended on which alias happened to come LAST — Python
    # set order varies with PYTHONHASHSEED, so a regen could flip a brand
    # between Travel and Other from run to run.
    ("Travel", re.compile(r"\b(air lines|airlines|airways|air)\b$", re.I)),
    (
        "Meals",
        re.compile(
            r"\b(pizza|burger|taco|grill|cafe|caffe|coffee|donuts?|doughnuts|bakery|"
            r"restaurant|steakhouse|sushi|bbq|barbecue|chicken|sandwich(es)?|subs?|"
            r"wings|diner|bistro|brewing|brewery|bar & grill|ice cream|smoothie|"
            r"juice|bagels?|pancakes?|waffle|noodle|ramen|pho|kitchen|eatery|"
            r"roadhouse|cantina|chophouse|buffet)\b",
            re.I,
        ),
    ),
    ("Ground Transportation", re.compile(r"\b(rent[- ]?a[- ]?car|car rental|parking)\b", re.I)),
    ("Shipping & Postage", re.compile(r"\b(shipping|postal|post office|courier)\b", re.I)),
]


def refine_misc(name: str, aliases: set[str]) -> str:
    override = NAME_OVERRIDES.get(name)
    if override:
        return override
    for category, rx in MISC_REFINE:
        # Per-string matching keeps the result independent of set iteration
        # order (the aliases are a set).
        if any(rx.search(s) for s in (name, *sorted(aliases))):
            return category
    return "Other"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--source",
        default=str(HERE.parent.parent / "Reimbursements" / "vendor_db.py"),
        help="Path to the original vendor_db.py",
    )
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f"source not found: {src}", file=sys.stderr)
        return 1

    spec = importlib.util.spec_from_file_location("vendor_db", src)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    known: dict[str, tuple[str, set[str]]] = mod.KNOWN_VENDORS
    slogans: set[str] = getattr(mod, "_SLOGANS", set())

    entries = []
    for name, (cat, aliases) in sorted(known.items()):
        plain = sorted(a for a in aliases if a not in slogans)
        slogan_aliases = sorted(a for a in aliases if a in slogans)
        category = CATEGORY_BASE[cat]
        if cat == "misc":
            category = refine_misc(name, aliases)
        entry: dict[str, object] = {
            "name": name,
            "category": category,
            "aliases": plain,
        }
        if slogan_aliases:
            entry["slogans"] = slogan_aliases
        entries.append(entry)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    total_aliases = sum(len(e["aliases"]) for e in entries)
    print(f"wrote {len(entries)} brands / {total_aliases} aliases → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
