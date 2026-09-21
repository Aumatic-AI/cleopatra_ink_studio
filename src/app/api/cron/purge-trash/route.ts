import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { deleteSessionStorage } from "@/lib/session-storage-cleanup";

// Scheduled purge for the admin's "Recently Deleted" tab — see the PURGE JOB
// section in supabase-schema.sql for the pg_cron job that calls this daily.
// Sessions soft-deleted more than TRASH_RETENTION_DAYS ago get permanently
// removed: files from session-assets, then the row (cascades to
// tattoo_designs/placements/chat_messages). This route is the only place
// that actually touches storage/tables — the cron job itself just triggers
// this HTTP call, nothing more.
export const maxDuration = 300;

const TRASH_RETENTION_DAYS = 30;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: expiredSessions, error: queryError } = await supabase
    .from("sessions")
    .select("id")
    .not("deleted_at", "is", null)
    .lt("deleted_at", cutoff);

  if (queryError) {
    console.error("[purge-trash] Failed to query expired sessions:", queryError.message);
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }

  if (!expiredSessions || expiredSessions.length === 0) {
    console.log("[purge-trash] No expired trash sessions found.");
    return NextResponse.json({ purged: 0, filesRemoved: 0 });
  }

  console.log(`[purge-trash] Found ${expiredSessions.length} session(s) past the ${TRASH_RETENTION_DAYS}-day retention window.`);

  let totalFilesRemoved = 0;
  const purged: string[] = [];
  const failed: string[] = [];

  for (const session of expiredSessions) {
    try {
      const filesRemoved = await deleteSessionStorage(supabase, session.id);
      totalFilesRemoved += filesRemoved;

      const { error: deleteError } = await supabase.from("sessions").delete().eq("id", session.id);
      if (deleteError) throw new Error(deleteError.message);

      purged.push(session.id);
      console.log(`[purge-trash] Session ${session.id} purged (${filesRemoved} files).`);
    } catch (err) {
      failed.push(session.id);
      console.error(`[purge-trash] Failed to purge session ${session.id}:`, (err as Error).message);
    }
  }

  // Piggyback the generation-job table's cleanup on this same daily trigger
  // rather than adding a second cron entry — see AGENTS.md on never adding
  // an undocumented cron job. generation-jobs.ts already deletes a stale row
  // lazily whenever it's polled again; this catches the rest (a job nobody
  // ever polls again, e.g. the tab was closed and never reopened).
  const { error: jobsPurgeError } = await supabase
    .from("generation_jobs")
    .delete()
    .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (jobsPurgeError) {
    console.error("[purge-trash] Failed to purge stale generation_jobs:", jobsPurgeError.message);
  }

  return NextResponse.json({
    purged: purged.length,
    failed: failed.length,
    filesRemoved: totalFilesRemoved,
    sessionIds: purged,
    ...(failed.length > 0 && { failedIds: failed }),
  });
}
