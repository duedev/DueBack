import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findByName,
  findByNumber,
  pairSaved,
  removeJob,
  upsertJob,
  type SavedJob,
} from "../src/store/jobs.ts";

const jobs: SavedJob[] = [
  { name: "Riverside Remodel", number: "JOB-1042" },
  { name: "Harbor Point", number: "JOB-2210" },
];

test("lookup is case-insensitive and whitespace-tolerant", () => {
  assert.equal(findByName(jobs, "riverside remodel")?.number, "JOB-1042");
  assert.equal(findByName(jobs, "  Riverside   Remodel  ")?.number, "JOB-1042");
  assert.equal(findByNumber(jobs, "job-2210")?.name, "Harbor Point");
  assert.equal(findByName(jobs, ""), undefined);
  assert.equal(findByNumber(jobs, "   "), undefined);
  assert.equal(findByName(jobs, "Riverside"), undefined, "prefix is not a match");
});

test("upsertJob adds new pairs newest-first and replaces by name", () => {
  const added = upsertJob(jobs, "New Build", "JOB-9");
  assert.equal(added.length, 3);
  assert.deepEqual(added[0], { name: "New Build", number: "JOB-9" });

  const replaced = upsertJob(jobs, "riverside remodel", "JOB-9999");
  assert.equal(replaced.length, 2);
  assert.equal(findByName(replaced, "Riverside Remodel")?.number, "JOB-9999");
});

test("upsertJob normalizes whitespace and ignores fully empty pairs", () => {
  const next = upsertJob([], "  Dock   Repair ", "   77 ");
  assert.deepEqual(next[0], { name: "Dock Repair", number: "77" });
  assert.equal(upsertJob(jobs, "  ", "").length, jobs.length);
});

test("pairSaved matches only the exact stored pairing", () => {
  assert.equal(pairSaved(jobs, "Harbor Point", "JOB-2210"), true);
  assert.equal(pairSaved(jobs, "harbor point", "job-2210"), true);
  assert.equal(pairSaved(jobs, "Harbor Point", "JOB-1042"), false);
  assert.equal(pairSaved(jobs, "Unknown", "JOB-2210"), false);
});

test("removeJob forgets by name, case-insensitively", () => {
  const next = removeJob(jobs, "HARBOR POINT");
  assert.equal(next.length, 1);
  assert.equal(next[0]!.name, "Riverside Remodel");
});
