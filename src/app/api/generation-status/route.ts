import { NextRequest } from "next/server";
import { getJob, isJobDone } from "@/lib/generation-jobs";

// Polled by the chat screen instead of holding one connection open for the
// full generation — also what lets a page reload resume watching an
// in-progress batch instead of losing it.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "sessionId is required" }, { status: 400 });

  const job = await getJob(sessionId);
  if (!job) return Response.json({ found: false });

  return Response.json({
    found: true,
    iteration: job.iteration,
    parentDesignIds: job.parentDesignIds,
    userInstruction: job.userInstruction,
    done: isJobDone(job),
    slots: job.slots,
  });
}
