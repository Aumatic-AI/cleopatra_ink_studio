// Supabase-backed generation job tracker. Was an in-memory Map pinned to
// globalThis — that only works on a single persistent process (Render). A
// serverless deployment (Vercel) can run the POST that starts a job and the
// later GET polls on different instances, which an in-memory store can't
// survive, so job state lives in generation_jobs / generation_job_slots
// (see supabase-schema.sql) instead.
//
// Slots are their own table (one row per parallel generation task), not a
// JSON array column on the job row — that way concurrent tasks completing
// around the same time each update only their own row. A shared JSON blob
// would need read-modify-write per update, which races when two tasks
// finish close together and one write silently clobbers the other.

import { createServiceClient } from "@/lib/supabase-server";

export interface JobSlot {
  status: "pending" | "done" | "error";
  imageBase64?: string;
  reason?: string;
  code?: string;
  // Which image-generation model this slot used — set on both success and
  // error so a failed slot's tag is still meaningful. Absent for slots that
  // never got far enough to know (e.g. a request that failed before model
  // selection).
  model?: string;
}

export interface Job {
  iteration: number;
  parentDesignIds: string[];
  userInstruction: string | null;
  slots: JobSlot[];
  createdAt: number;
}

// Generation is documented at 1-3 minutes (placement up to 3). Well past
// that with slots still "pending" means the server died mid-run (e.g. a
// serverless invocation killed before finishing), not that it's still
// working — surface a clear failure instead of leaving the client polling
// forever with nothing to show.
const JOB_TIMEOUT_MS = 6 * 60 * 1000;
// Rows older than this are dropped outright on read, regardless of status —
// keeps the table from growing unbounded between the daily cron cleanup.
const JOB_TTL_MS = 30 * 60 * 1000;

const RETRY_ATTEMPTS = 3;
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node's `fetch` throws a bare `TypeError: fetch failed` for almost any
// underlying network problem — the actual reason (ECONNRESET, ENOTFOUND,
// a TLS failure, etc.) is on `.cause`, one or more levels deep, and gets
// silently discarded by a plain `error.message` read. Without this, every
// failure here looks identical regardless of cause — see the Known
// machine-specific issue note in AGENTS.md.
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    let cause = (err as { cause?: unknown }).cause;
    for (let depth = 0; depth < 3 && cause; depth++) {
      if (cause instanceof Error) {
        parts.push(cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(describeError(cause));
        break;
      }
    }
    return parts.join(" — caused by: ");
  }
  // Supabase/Postgrest errors are plain objects, not Error instances —
  // String(plainObject) is "[object Object]", not remotely useful. Pull out
  // whichever of its real fields exist instead.
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts = [obj.message, obj.details, obj.hint, obj.code]
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (parts.length > 0) return parts.join(" — ");
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// The Node-side fetch-to-Supabase flakiness noted in AGENTS.md applies here
// too, and these calls are unavoidably server-side (already inside the
// service-role generation routes). Same retry-with-backoff convention as
// browser-upload.ts's uploadBlobDirect.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) await sleep(500 * attempt);
    }
  }
  throw new Error(describeError(lastError));
}

// Starting a job replaces any previous one under the same key (a session/
// design only ever watches one batch at a time). Delete-then-insert
// guarantees fresh slot rows even when the key is reused for iteration
// 2, 3, ... — the FK's on delete cascade clears old slots automatically.
export async function startJob(
  jobKey: string,
  iteration: number,
  count: number,
  parentDesignIds: string[] = [],
  userInstruction: string | null = null
): Promise<Job> {
  const supabase = createServiceClient();

  await withRetry(async () => {
    const { error } = await supabase.from("generation_jobs").delete().eq("job_key", jobKey);
    if (error) throw error;
  });

  await withRetry(async () => {
    const { error } = await supabase.from("generation_jobs").insert({
      job_key: jobKey,
      iteration,
      parent_design_ids: parentDesignIds,
      user_instruction: userInstruction,
    });
    if (error) throw error;
  });

  await withRetry(async () => {
    const { error } = await supabase.from("generation_job_slots").insert(
      Array.from({ length: count }, (_, index) => ({ job_key: jobKey, slot_index: index }))
    );
    if (error) throw error;
  });

  return {
    iteration,
    parentDesignIds,
    userInstruction,
    slots: Array.from({ length: count }, () => ({ status: "pending" as const })),
    createdAt: Date.now(),
  };
}

export async function getJob(jobKey: string): Promise<Job | undefined> {
  const supabase = createServiceClient();

  const { data: jobRow, error: jobError } = await supabase
    .from("generation_jobs")
    .select("iteration, parent_design_ids, user_instruction, created_at")
    .eq("job_key", jobKey)
    .maybeSingle();
  if (jobError || !jobRow) return undefined;

  const createdAt = new Date(jobRow.created_at).getTime();
  const age = Date.now() - createdAt;

  if (age > JOB_TTL_MS) {
    await supabase.from("generation_jobs").delete().eq("job_key", jobKey);
    return undefined;
  }

  if (age > JOB_TIMEOUT_MS) {
    // Guarded by status='pending' so a slot that finishes right as this
    // fires never gets clobbered — whichever write lands first, lands.
    await supabase
      .from("generation_job_slots")
      .update({ status: "error", reason: "Generation timed out. Please try again." })
      .eq("job_key", jobKey)
      .eq("status", "pending");
  }

  const { data: slotRows, error: slotsError } = await supabase
    .from("generation_job_slots")
    .select("status, image_base64, reason, code, model")
    .eq("job_key", jobKey)
    .order("slot_index", { ascending: true });
  if (slotsError || !slotRows) return undefined;

  return {
    iteration: jobRow.iteration,
    parentDesignIds: jobRow.parent_design_ids ?? [],
    userInstruction: jobRow.user_instruction,
    slots: slotRows.map((row) => ({
      status: row.status as JobSlot["status"],
      imageBase64: row.image_base64 ?? undefined,
      reason: row.reason ?? undefined,
      code: row.code ?? undefined,
      model: row.model ?? undefined,
    })),
    createdAt,
  };
}

export async function setSlot(jobKey: string, index: number, slot: JobSlot): Promise<void> {
  try {
    const supabase = createServiceClient();
    await withRetry(async () => {
      const { error } = await supabase
        .from("generation_job_slots")
        .update({
          status: slot.status,
          image_base64: slot.imageBase64 ?? null,
          reason: slot.reason ?? null,
          code: slot.code ?? null,
          model: slot.model ?? null,
        })
        .eq("job_key", jobKey)
        .eq("slot_index", index);
      if (error) throw error;
    });
  } catch (err) {
    // Never let a failed status write take down the generation itself — log
    // it and move on. If this slot's real result never makes it into the
    // row, the timeout sweep in getJob() is the backstop that still turns
    // it into a visible failure instead of an endless "pending".
    console.error(`[generation-jobs] Failed to persist slot ${index} for ${jobKey}:`, (err as Error).message);
  }
}

export function isJobDone(job: Job): boolean {
  return job.slots.every((s) => s.status !== "pending");
}
