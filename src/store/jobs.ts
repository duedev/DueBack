import { repo } from "./repo.ts";

// Saved job name ⇄ number pairs. Jobs always travel as a pair, so the report
// bar autofills one side when the other matches a saved job (and offers both
// as datalist suggestions). Stored in the local kv store; Settings lists and
// forgets them. The list helpers are pure (Node-tested); only the load/save
// wrappers touch IndexedDB.

export interface SavedJob {
  name: string;
  number: string;
}

const KV_KEY = "jobs.saved";
const MAX_JOBS = 200;

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");
const fold = (s: string): string => norm(s).toLowerCase();

/** Find the saved pair for a typed job name ("" and whitespace never match). */
export function findByName(jobs: readonly SavedJob[], name: string): SavedJob | undefined {
  const key = fold(name);
  return key ? jobs.find((j) => fold(j.name) === key) : undefined;
}

/** Find the saved pair for a typed job number. */
export function findByNumber(jobs: readonly SavedJob[], number: string): SavedJob | undefined {
  const key = fold(number);
  return key ? jobs.find((j) => fold(j.number) === key) : undefined;
}

/** True when this exact pair is already saved. */
export function pairSaved(jobs: readonly SavedJob[], name: string, number: string): boolean {
  const hit = findByName(jobs, name);
  return !!hit && fold(hit.number) === fold(number);
}

/** Add/replace a pair (keyed by name, case-insensitive), newest first. */
export function upsertJob(jobs: readonly SavedJob[], name: string, number: string): SavedJob[] {
  const entry: SavedJob = { name: norm(name), number: norm(number) };
  if (!entry.name && !entry.number) return [...jobs];
  const rest = jobs.filter((j) => fold(j.name) !== fold(entry.name));
  return [entry, ...rest].slice(0, MAX_JOBS);
}

export function removeJob(jobs: readonly SavedJob[], name: string): SavedJob[] {
  return jobs.filter((j) => fold(j.name) !== fold(name));
}

// ---- persistence (local kv) ------------------------------------------------

export async function listSavedJobs(): Promise<SavedJob[]> {
  const raw = await repo.getSetting<SavedJob[]>(KV_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (j): j is SavedJob =>
      !!j && typeof j.name === "string" && typeof j.number === "string",
  );
}

export async function saveJobPair(name: string, number: string): Promise<SavedJob[]> {
  const next = upsertJob(await listSavedJobs(), name, number);
  await repo.setSetting(KV_KEY, next);
  return next;
}

export async function forgetJob(name: string): Promise<SavedJob[]> {
  const next = removeJob(await listSavedJobs(), name);
  await repo.setSetting(KV_KEY, next);
  return next;
}
