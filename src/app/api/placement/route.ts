import { NextRequest, after } from "next/server";
import { createKeiTask, waitForKeiTask, KeiTaskFailedError, KeiCreditsError } from "@/lib/kei-api";
// TEST: swapped from "@/lib/prompts" to the minimal-prompt version — see
// prompts-test.ts. Revert this import to go back to the full-length prompts.
import {
  buildPlacementPrompt,
  buildCompositePrompt,
  buildCompositePromptForComplexAnatomy,
  classifySurface,
} from "@/lib/prompts-test";
import { startJob, setSlot } from "@/lib/generation-jobs";

export const maxDuration = 300;

type KeiRunResult =
  | { ok: true; url: string; taskId: string }
  | { ok: false; kind: "failed" | "timeout" | "error" | "credits"; reason: string; taskId?: string };

type PlacementModel = "gpt-image-2-image-to-image" | "nano-banana-pro";

// One placement generation now produces one result per model, not a staff
// choice — see the AGENTS.md note on this. Slot 0 stays gpt-image, the model
// already proven correct here: nano-banana-pro was tried and rejected for
// this specific job because it let the tattoo's position/pose drift instead
// of strictly preserving the composite, which gpt-image's edit mode handles
// correctly ("change only this, preserve everything else"). Slot 1 is the
// side-by-side comparison so staff can judge for themselves rather than
// trust that old finding forever.
const PLACEMENT_MODELS: readonly PlacementModel[] = ["gpt-image-2-image-to-image", "nano-banana-pro"];

// Single attempt at a KEI generation. Caller decides whether to retry.
async function runKeiOnce(prompt: string, inputUrls: string[], model: PlacementModel): Promise<KeiRunResult> {
  let taskId: string | undefined;
  try {
    taskId = await createKeiTask(prompt, inputUrls, { model });
    const url = await waitForKeiTask(taskId);
    return { ok: true, url, taskId };
  } catch (err) {
    if (err instanceof KeiCreditsError) {
      return { ok: false, kind: "credits", reason: err.message };
    }
    if (err instanceof KeiTaskFailedError) {
      return { ok: false, kind: "failed", reason: err.failMsg ?? err.message, taskId: err.taskId };
    }
    const reason = (err as Error).message;
    const kind: "timeout" | "error" = /timed out/i.test(reason) ? "timeout" : "error";
    return { ok: false, kind, reason, taskId };
  }
}

// Up to two attempts: one retry on real failures (KEI 5xx, "Internal Error",
// moderation flake). Timeouts and credits errors are not retried — a retry
// would just queue the same doomed job and burn the request budget.
async function runKeiWithRetry(prompt: string, inputUrls: string[], model: PlacementModel): Promise<KeiRunResult> {
  const first = await runKeiOnce(prompt, inputUrls, model);
  if (first.ok || first.kind === "timeout" || first.kind === "credits") return first;
  console.warn(`[placement] KEI ${first.kind} (${first.reason}) — retrying once`);
  return runKeiOnce(prompt, inputUrls, model);
}

// Fetching from KEI works reliably from this server (unlike uploading TO
// Supabase, which doesn't) — download the result here but hand the bytes to
// the browser as base64 and let it do the upload.
async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

// Keyed separately from the chat's per-session generation job so a
// placement generation never collides with an in-flight chat edit.
function placementJobKey(sessionId: string): string {
  return `placement:${sessionId}`;
}

export async function POST(req: NextRequest) {
  // tattooImageUrl / bodyPhotoUrl / compositeUrl are already-hosted Supabase
  // URLs — the browser uploads them directly before calling this route,
  // since uploading TO Supabase from this server is unreliable.
  const { sessionId, tattooImageUrl, bodyPhotoUrl, compositeUrl, placementText } = await req.json();

  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!tattooImageUrl && !compositeUrl) {
    return Response.json({ error: "tattooImageUrl or compositeUrl is required" }, { status: 400 });
  }

  let prompt: string;
  let inputUrls: string[];

  // ── Composite mode: user manually positioned the tattoo ──────────────
  // Sends 3 images: composite (position) + tattoo design (detail) + body photo (skin/light)
  if (compositeUrl) {
    inputUrls = [compositeUrl];
    if (tattooImageUrl) inputUrls.push(tattooImageUrl as string);
    if (bodyPhotoUrl) inputUrls.push(bodyPhotoUrl as string);

    const surface = classifySurface(placementText ?? "");
    prompt = surface === "flat" ? buildCompositePrompt() : buildCompositePromptForComplexAnatomy(surface);
  } else {
    // ── Standard mode: separate tattoo + optional body photo ────────────
    inputUrls = [tattooImageUrl];
    if (bodyPhotoUrl) inputUrls.push(bodyPhotoUrl as string);
    prompt = buildPlacementPrompt(placementText ?? "", !!bodyPhotoUrl);
  }

  // ── Start the job and return immediately ─────────────────────────────
  // The client polls /api/generation-status instead of holding this
  // connection open for the 1-3 minutes this generation can take — that
  // also means a page reload doesn't kill an in-progress preview. One slot
  // per model in PLACEMENT_MODELS, run in parallel exactly like the AI
  // Design/Rework batches.
  const jobKey = placementJobKey(sessionId);
  try {
    await startJob(jobKey, 1, PLACEMENT_MODELS.length);
  } catch (err) {
    return Response.json({ error: `Couldn't start the generation job: ${(err as Error).message}` }, { status: 500 });
  }

  after(async () => {
    await Promise.allSettled(
      PLACEMENT_MODELS.map((model, index) =>
        runKeiWithRetry(prompt, inputUrls, model)
          .then(async (result) => {
            if (!result.ok) {
              console.warn(`[placement] ${model} generation failed: ${result.reason}`);
              await setSlot(jobKey, index, {
                status: "error",
                reason: result.reason,
                code: result.kind === "credits" ? "insufficient_credits" : undefined,
                model,
              });
              return;
            }
            try {
              const imageBase64 = await fetchAsBase64(result.url);
              await setSlot(jobKey, index, { status: "done", imageBase64, model });
            } catch (err) {
              console.error(`[placement] fetching ${model} result failed:`, err);
              await setSlot(jobKey, index, { status: "error", reason: `Fetching result failed: ${(err as Error).message}`, model });
            }
          })
          .catch((err) => setSlot(jobKey, index, { status: "error", reason: (err as Error).message, model }))
      )
    );
  });

  return Response.json({ ok: true });
}
