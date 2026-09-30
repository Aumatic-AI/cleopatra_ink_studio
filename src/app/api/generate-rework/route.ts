import { NextRequest, after } from "next/server";
import { createKeiTask, waitForKeiTask, KeiTaskFailedError, KeiCreditsError } from "@/lib/kei-api";
import { buildReworkPrompt } from "@/lib/prompts-rework";
import { uploadBase64 } from "@/lib/storage";
import { startJob, setSlot } from "@/lib/generation-jobs";

// Fetching from KEI works reliably from this server (unlike uploading TO
// Supabase, which doesn't) — so download the result here but hand the bytes
// to the browser as base64 and let IT do the unreliable-from-Node upload.
async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

type RunResult =
  | { ok: true; url: string }
  | { ok: false; reason: string; taskId?: string; credits?: boolean };

async function runOneTask(prompt: string, inputUrls: string[]): Promise<RunResult> {
  let taskId: string | undefined;
  try {
    taskId = await createKeiTask(prompt, inputUrls, { model: "nano-banana-pro" });
    const url = await waitForKeiTask(taskId);
    return { ok: true, url };
  } catch (err) {
    if (err instanceof KeiCreditsError) return { ok: false, reason: err.message, credits: true };
    if (err instanceof KeiTaskFailedError) return { ok: false, reason: err.failMsg ?? "Unknown KEI failure", taskId: err.taskId };
    return { ok: false, reason: (err as Error).message, taskId };
  }
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const {
    sessionId,
    iteration,
    description = "",
    mode,
    count = 5,
    sourcePhoto,       // base64 — first generation only
    sourcePhotoUrl,    // already-hosted — first generation, resumed session
    editInstruction = "",
    editSourceUrls = [] as string[],
    parentDesignIds = [] as string[], // tattoo_designs.id values — for job/lineage tracking, not generation input
  } = await req.json();

  if (mode !== "cover" && mode !== "extend") {
    return Response.json({ error: "mode must be 'cover' or 'extend'" }, { status: 400 });
  }
  if (!sessionId || typeof iteration !== "number") {
    return Response.json({ error: "sessionId and iteration are required" }, { status: 400 });
  }

  const isEdit = editInstruction.trim().length > 0;

  if (isEdit && editSourceUrls.length === 0) {
    return Response.json({ error: "At least one reference image is required to edit" }, { status: 400 });
  }
  if (!isEdit && !description.trim()) {
    return Response.json({ error: "description is required" }, { status: 400 });
  }

  let sourceUrl: string;
  if (isEdit) {
    sourceUrl = editSourceUrls[0];
  } else if (sourcePhotoUrl) {
    sourceUrl = sourcePhotoUrl;
  } else if (sourcePhoto) {
    try {
      sourceUrl = await uploadBase64(sourcePhoto, sessionId, "rework-source");
    } catch (err) {
      return Response.json({ error: `Photo upload failed: ${(err as Error).message}` }, { status: 500 });
    }
  } else {
    return Response.json({ error: "A photo of the existing tattoo is required" }, { status: 400 });
  }

  const inputUrls = isEdit ? editSourceUrls : [sourceUrl];

  const prompt = buildReworkPrompt({
    description,
    mode,
    editInstruction: isEdit ? editInstruction : undefined,
    imageCount: inputUrls.length,
  });

  const clampedCount = Math.min(5, Math.max(1, Number(count) || 5));
  try {
    await startJob(sessionId, iteration, clampedCount, isEdit ? parentDesignIds : [], isEdit ? editInstruction : null);
  } catch (err) {
    return Response.json({ error: `Couldn't start the generation job: ${(err as Error).message}` }, { status: 500 });
  }

  // Runs after the response is sent, but the platform is told to keep this
  // invocation alive until it resolves — unlike a bare fire-and-forget
  // promise, which a serverless platform can freeze the moment the response
  // goes out. The client polls /api/generation-status for progress instead
  // of holding a connection open for the full 1-2 minutes this can take.
  after(async () => {
    await Promise.allSettled(
      Array.from({ length: clampedCount }, (_, index) =>
        runOneTask(prompt, inputUrls)
          .then(async (result) => {
            if (!result.ok) {
              console.warn(`[generate-rework] task ${index} failed: ${result.reason}`);
              await setSlot(sessionId, index, { status: "error", reason: result.reason, code: result.credits ? "insufficient_credits" : undefined });
              return;
            }
            try {
              const imageBase64 = await fetchAsBase64(result.url);
              await setSlot(sessionId, index, { status: "done", imageBase64 });
            } catch (err) {
              console.error(`[generate-rework] fetching result failed for task ${index}:`, err);
              await setSlot(sessionId, index, { status: "error", reason: `Image fetch failed: ${(err as Error).message}` });
            }
          })
          .catch((err) => setSlot(sessionId, index, { status: "error", reason: (err as Error).message }))
      )
    );
  });

  return Response.json({ ok: true, iteration, sourcePhotoUrl: !isEdit ? sourceUrl : undefined });
}
