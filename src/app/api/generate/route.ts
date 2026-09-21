import { NextRequest, after } from "next/server";
import { buildTattooPrompt, createKeiTask, waitForKeiTask, KeiTaskFailedError, KeiCreditsError } from "@/lib/kei-api";
import type { RefinementInfo } from "@/lib/kei-api";
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

// When there's more than one reference image, rotate which one leads across
// the parallel generation slots. Otherwise every slot sees the exact same
// image order and the model consistently favors whichever came first, so a
// 3-reference batch of 5 ends up looking like "5 versions of reference #1"
// instead of a mix — paired with buildInitialDesignPrompt's "Image 1 is this
// variation's primary inspiration" wording, this is what actually makes the
// batch represent every reference the customer picked, not just the first.
function rotateReferences(refs: string[], slotIndex: number): string[] {
  if (refs.length <= 1) return refs;
  const lead = slotIndex % refs.length;
  return [refs[lead], ...refs.filter((_, i) => i !== lead)];
}

async function runOneTask(prompt: string, inputUrls: string[], model: "gpt-image-2-image-to-image" | "nano-banana-pro" = "gpt-image-2-image-to-image"): Promise<RunResult> {
  let taskId: string | undefined;
  try {
    taskId = await createKeiTask(prompt, inputUrls, { model });
    const url = await waitForKeiTask(taskId);
    return { ok: true, url };
  } catch (err) {
    if (err instanceof KeiCreditsError) {
      return { ok: false, reason: err.message, credits: true };
    }
    if (err instanceof KeiTaskFailedError) {
      return { ok: false, reason: err.failMsg ?? "Unknown KEI failure", taskId: err.taskId };
    }
    return { ok: false, reason: (err as Error).message, taskId };
  }
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const {
    sessionId,
    iteration,
    description,
    style,
    images: b64Images = [],
    referenceImageUrls = [] as string[],
    refineImageUrls = [] as string[],
    refinementText = "",
    faithfulMode = false,
    isTextTattoo = false,
    selectedDesignNames = [] as string[],
    colors = [] as string[],
    targetBodyArea = "",
    count = 5,
    textTattooFont,
    parentDesignIds = [] as string[], // tattoo_designs.id values — for job/lineage tracking, not generation input
  } = await req.json();

  if (!description?.trim()) {
    return Response.json({ error: "description is required" }, { status: 400 });
  }
  if (!sessionId || typeof iteration !== "number") {
    return Response.json({ error: "sessionId and iteration are required" }, { status: 400 });
  }

  const isRefinement = refineImageUrls.length > 0 && refinementText.trim().length > 0;

  // ── Build input URL list ─────────────────────────────────────────────
  // References can come in two shapes:
  //   - `images`: base64 payloads (fresh blob URLs from dropzone/camera) → upload here
  //   - `referenceImageUrls`: already-hosted URLs (Pinterest pins uploaded in the background) → pass through
  // Mixing them lets us avoid re-uploading already-stored Pinterest images.
  let uploadedRefUrls: string[] = [];
  if ((b64Images as string[]).length > 0) {
    try {
      uploadedRefUrls = await Promise.all(
        (b64Images as string[]).map((b64) => uploadBase64(b64, sessionId, "refs"))
      );
    } catch (err) {
      return Response.json({ error: `Image upload failed: ${(err as Error).message}` }, { status: 500 });
    }
  }

  const hostedRefs = (referenceImageUrls as string[]).filter((u) => typeof u === "string" && u.length > 0);
  const allRefs = [...uploadedRefUrls, ...hostedRefs];

  if (!isRefinement && allRefs.length === 0) {
    return Response.json({ error: "At least one reference image is required" }, { status: 400 });
  }

  let inputUrls: string[];
  if (isRefinement) {
    inputUrls = [...(refineImageUrls as string[]), ...allRefs];
  } else {
    inputUrls = allRefs;
  }

  // ── Build prompt ─────────────────────────────────────────────────────
  let refinementInfo: RefinementInfo | undefined;
  if (isRefinement) {
    refinementInfo = {
      text: refinementText as string,
      faithfulMode: faithfulMode as boolean,
      selectedImages: (refineImageUrls as string[]).map((_, i) => ({
        name: (selectedDesignNames as string[])[i] ?? `Variation ${i + 1}`,
        index: i + 1,
      })),
    };
  }

  const hasUserRefs = allRefs.length > 0;
  const generationModel = (isTextTattoo as boolean) ? "nano-banana-pro" : "gpt-image-2-image-to-image";
  const prompt = buildTattooPrompt(
    description,
    style ?? "",
    hasUserRefs,
    refinementInfo,
    Array.isArray(colors) ? (colors as string[]) : [],
    typeof targetBodyArea === "string" ? targetBodyArea : "",
    isTextTattoo as boolean,
    textTattooFont ? { font: textTattooFont } : undefined,
    allRefs.length
  );

  // ── Start the job and return immediately ─────────────────────────────
  // The client polls /api/generation-status instead of holding this
  // connection open for the 1-2 minutes generation can take — that also
  // means a page reload doesn't kill an in-progress batch.
  const clampedCount = Math.min(5, Math.max(1, Number(count) || 5));
  try {
    await startJob(sessionId, iteration, clampedCount, parentDesignIds, isRefinement ? refinementText : null);
  } catch (err) {
    return Response.json({ error: `Couldn't start the generation job: ${(err as Error).message}` }, { status: 500 });
  }

  // Runs after the response is sent, but — unlike a bare fire-and-forget
  // promise — the platform is told to keep this invocation alive until it
  // resolves. On Vercel a plain un-awaited promise can be frozen the moment
  // the response goes out; after() is what actually survives that.
  after(async () => {
    await Promise.allSettled(
      Array.from({ length: clampedCount }, (_, index) => {
        // Refinement's inputUrls lead with the images being refined, not
        // the style references — rotation is scoped to the reported bug
        // (initial-generation batches biased toward the first reference).
        const slotInputUrls = isRefinement ? inputUrls : rotateReferences(inputUrls, index);
        return runOneTask(prompt, slotInputUrls, generationModel)
          .then(async (result) => {
            if (!result.ok) {
              console.warn(`[generate] task ${index} failed: ${result.reason}`);
              await setSlot(sessionId, index, { status: "error", reason: result.reason, code: result.credits ? "insufficient_credits" : undefined });
              return;
            }
            try {
              const imageBase64 = await fetchAsBase64(result.url);
              await setSlot(sessionId, index, { status: "done", imageBase64 });
            } catch (err) {
              console.error(`[generate] fetching result failed for task ${index}:`, err);
              await setSlot(sessionId, index, { status: "error", reason: `Image fetch failed: ${(err as Error).message}` });
            }
          })
          .catch((err) => setSlot(sessionId, index, { status: "error", reason: (err as Error).message }));
      })
    );
  });

  return Response.json({ ok: true, iteration });
}
