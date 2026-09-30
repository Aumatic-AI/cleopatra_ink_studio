import { NextRequest, after } from "next/server";
import { createKeiTask, waitForKeiTask, KeiTaskFailedError, KeiCreditsError } from "@/lib/kei-api";
import { startJob, setSlot } from "@/lib/generation-jobs";

// Deliberately minimal, same lesson as prompts-rework.ts: a short, direct
// instruction gets a cleaner isolate than a long list of constraints.
const FLASH_PROMPT =
  "Isolate just the tattoo design from this photo. Show it as a clean, flat tattoo design on a plain white background — no skin, no body, no shadows.";

// Fetching from KEI works reliably from this server (unlike uploading TO
// Supabase, which doesn't) — download the result here but hand the bytes to
// the browser as base64 and let it do the upload + DB persist.
async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { designId, imageUrl } = await req.json();

  if (!designId || !imageUrl) {
    return Response.json({ error: "designId and imageUrl are required" }, { status: 400 });
  }

  // Keyed separately from the chat's per-session job so finalizing a design
  // (which can happen mid-chat) never collides with an in-flight chat edit.
  const jobKey = `flash:${designId}`;
  try {
    await startJob(jobKey, 1, 1);
  } catch (err) {
    return Response.json({ error: `Couldn't start the generation job: ${(err as Error).message}` }, { status: 500 });
  }

  after(async () => {
    try {
      const taskId = await createKeiTask(FLASH_PROMPT, [imageUrl], { model: "nano-banana-pro" });
      const url = await waitForKeiTask(taskId);
      const imageBase64 = await fetchAsBase64(url);
      await setSlot(jobKey, 0, { status: "done", imageBase64 });
    } catch (err) {
      if (err instanceof KeiCreditsError) {
        await setSlot(jobKey, 0, { status: "error", reason: err.message, code: "insufficient_credits" });
      } else if (err instanceof KeiTaskFailedError) {
        await setSlot(jobKey, 0, { status: "error", reason: err.failMsg ?? "Unknown KEI failure" });
      } else {
        await setSlot(jobKey, 0, { status: "error", reason: (err as Error).message });
      }
    }
  });

  return Response.json({ ok: true });
}
