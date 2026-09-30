"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";
import { resolveImageSrc } from "@/lib/image-src";
import ActiveSessionsModal from "@/components/dashboard/ActiveSessionsModal";
import Link from "next/link";

const WORK_PAGE_SIZE = 12;
const TREND_DAYS = 14;
const MIN_DESIGNERS_FOR_LEADERBOARD = 3;

// Bucket by the browser's LOCAL calendar day, not UTC — a plain
// toISOString().slice(0,10) shifts local midnight into the previous UTC day
// for any positive-offset timezone, so bucket keys built that way never
// match the (also-local) day a session was actually created on.
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Kpis {
  activeSessions: number;
  completedThisWeek: number;
  totalCustomers: number;
  designersActive: number;
  designersTotal: number;
  completionRate: number | null; // null when there's no data yet to divide by
}

interface AttentionItem {
  id: string;
  tattoo_style: string | null;
  created_at: string;
  customerName: string;
}

interface TrendPoint {
  date: string; // yyyy-mm-dd, local — also the bucket key
  dateLabel: string; // compact axis label — day-of-month only, e.g. "13"
  weekday: string; // full weekday for the hover tooltip, e.g. "Monday"
  count: number;
}

interface LeaderboardRow {
  designerId: string;
  name: string;
  count: number;
}

interface WorkItem {
  id: string; // session id
  imageUrl: string;
  styleName: string | null;
  customerName: string;
  designerName: string;
  status: string;
  createdAt: string;
}

export default function AdminDashboard() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [loading, setLoading] = useState(true);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [attentionTotal, setAttentionTotal] = useState(0);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[] | null>(null); // null = don't show section

  const [work, setWork] = useState<WorkItem[]>([]);
  const [workTotal, setWorkTotal] = useState(0);
  const [loadingMoreWork, setLoadingMoreWork] = useState(false);
  const [showActiveSessions, setShowActiveSessions] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/studio/login"); return; }

    const { data: staffCheck } = await supabase
      .from("staff").select("role").eq("id", user.id).maybeSingle();
    if (staffCheck?.role !== "admin") { router.push("/studio/designer"); return; }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const trendStart = new Date(now.getTime() - (TREND_DAYS - 1) * 24 * 60 * 60 * 1000);
    trendStart.setHours(0, 0, 0, 0);

    // Everything below is independent, so it all fires in parallel. Every
    // count is {count:"exact", head:true} — no rows transferred — except the
    // handful of queries that need actual rows (needs-attention list, trend
    // buckets, leaderboard, recent-work grid), each capped to what's shown.
    const [
      designersTotalRes,
      designersActiveRes,
      customersRes,
      activeSessionsRes,
      completedThisWeekRes,
      totalSessionsRes,
      completedAllTimeRes,
      attentionRes,
      trendRes,
      leaderboardRes,
      workRes,
    ] = await Promise.all([
      supabase.from("staff").select("id", { count: "exact", head: true })
        .eq("role", "designer").is("deleted_at", null),
      supabase.from("staff").select("id", { count: "exact", head: true })
        .eq("role", "designer").eq("is_active", true).is("deleted_at", null),
      supabase.from("users").select("id", { count: "exact", head: true }),
      supabase.from("sessions").select("id", { count: "exact", head: true })
        .eq("status", "active").is("deleted_at", null),
      supabase.from("sessions").select("id", { count: "exact", head: true })
        .eq("status", "completed").gte("completed_at", sevenDaysAgo).is("deleted_at", null),
      supabase.from("sessions").select("id", { count: "exact", head: true })
        .is("deleted_at", null),
      supabase.from("sessions").select("id", { count: "exact", head: true })
        .eq("status", "completed").is("deleted_at", null),
      supabase.from("sessions")
        .select("id, tattoo_style, created_at, users(first_name)", { count: "exact" })
        .eq("status", "active").is("designer_id", null).is("deleted_at", null)
        .order("created_at", { ascending: true })
        .range(0, 5),
      supabase.from("sessions").select("created_at")
        .is("deleted_at", null).gte("created_at", trendStart.toISOString()),
      supabase.from("sessions").select("designer_id, designer:designer_id(name)")
        .eq("status", "completed").not("designer_id", "is", null)
        .gte("completed_at", thirtyDaysAgo).is("deleted_at", null),
      supabase.from("sessions")
        .select(`
          id, status, created_at,
          users(first_name), designer:designer_id(name),
          tattoo_designs!inner(image_url, style_name),
          placements(final_composite_url, is_finalized)
        `, { count: "exact" })
        .eq("tattoo_designs.is_finalized", true)
        .eq("placements.is_finalized", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .range(0, WORK_PAGE_SIZE - 1),
    ]);

    const totalSessions = totalSessionsRes.count ?? 0;
    const completedAllTime = completedAllTimeRes.count ?? 0;

    setKpis({
      activeSessions: activeSessionsRes.count ?? 0,
      completedThisWeek: completedThisWeekRes.count ?? 0,
      totalCustomers: customersRes.count ?? 0,
      designersActive: designersActiveRes.count ?? 0,
      designersTotal: designersTotalRes.count ?? 0,
      completionRate: totalSessions > 0 ? completedAllTime / totalSessions : null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attentionRows = (attentionRes.data ?? []) as any[];
    setAttentionItems(attentionRows.map((r) => ({
      id: r.id,
      tattoo_style: r.tattoo_style,
      created_at: r.created_at,
      customerName: (Array.isArray(r.users) ? r.users[0] : r.users)?.first_name ?? "Unknown",
    })));
    setAttentionTotal(attentionRes.count ?? attentionRows.length);

    // Bucket raw timestamps into per-day counts for the trend chart, keyed
    // and labeled from the same local Date object so they can't drift apart.
    const buckets = new Map<string, number>();
    const labels = new Map<string, { dateLabel: string; weekday: string }>();
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
      const key = localDateKey(d);
      buckets.set(key, 0);
      labels.set(key, {
        dateLabel: String(d.getDate()),
        weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((trendRes.data ?? []) as any[]).forEach((r) => {
      const key = localDateKey(new Date(r.created_at));
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    });
    setTrend(Array.from(buckets, ([date, count]) => ({
      date,
      dateLabel: labels.get(date)?.dateLabel ?? "",
      weekday: labels.get(date)?.weekday ?? "",
      count,
    })));

    if ((designersTotalRes.count ?? 0) >= MIN_DESIGNERS_FOR_LEADERBOARD) {
      const counts = new Map<string, { name: string; count: number }>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((leaderboardRes.data ?? []) as any[]).forEach((r) => {
        const designer = Array.isArray(r.designer) ? r.designer[0] : r.designer;
        const existing = counts.get(r.designer_id);
        if (existing) existing.count += 1;
        else counts.set(r.designer_id, { name: designer?.name ?? "Unknown", count: 1 });
      });
      const rows: LeaderboardRow[] = Array.from(counts, ([designerId, v]) => ({ designerId, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      setLeaderboard(rows.length > 0 ? rows : null);
    } else {
      setLeaderboard(null);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workRows = (workRes.data ?? []) as any[];
    setWork(workRows.map(mapWorkRow));
    setWorkTotal(workRes.count ?? workRows.length);

    setLoading(false);
  }, [router, supabase]);

  useEffect(() => { load(); }, [load]);

  async function handleLoadMoreWork() {
    if (loadingMoreWork) return;
    setLoadingMoreWork(true);
    const { data } = await supabase
      .from("sessions")
      .select(`
        id, status, created_at,
        users(first_name), designer:designer_id(name),
        tattoo_designs!inner(image_url, style_name),
        placements(final_composite_url, is_finalized)
      `)
      .eq("tattoo_designs.is_finalized", true)
      .eq("placements.is_finalized", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(work.length, work.length + WORK_PAGE_SIZE - 1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setWork((prev) => [...prev, ...((data ?? []) as any[]).map(mapWorkRow)]);
    setLoadingMoreWork(false);
  }

  const hasMoreWork = work.length < workTotal;
  const todayKey = useMemo(() => localDateKey(new Date()), []);
  const maxTrendCount = useMemo(() => Math.max(1, ...trend.map((t) => t.count)), [trend]);
  const maxLeaderboardCount = useMemo(
    () => Math.max(1, ...(leaderboard ?? []).map((l) => l.count)),
    [leaderboard]
  );

  const statusColor = (s: string) =>
    s === "completed" ? "text-success" : s === "abandoned" ? "text-error" : "text-gold";

  if (loading) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="min-h-[100dvh] bg-bg flex flex-col">
      <AnimatePresence>
        {showActiveSessions && <ActiveSessionsModal onClose={() => setShowActiveSessions(false)} />}
      </AnimatePresence>

      <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 max-w-5xl mx-auto w-full flex flex-col gap-7 sm:gap-8">

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-gold text-[11px] font-mono tracking-[0.2em] uppercase mb-1">Studio Overview</p>
          <h1 className="font-cinzel text-2xl font-black text-ink">Dashboard</h1>
        </motion.div>

        {/* ── KPI strip ──────────────────────────────────────────── */}
        {kpis && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiTile label="Active Sessions" value={kpis.activeSessions} onClick={() => setShowActiveSessions(true)} />
            <KpiTile label="Completed (7d)" value={kpis.completedThisWeek} />
            <KpiTile label="Customers" value={kpis.totalCustomers} href="/studio/admin/customers" />
            <KpiTile label="Active Designers" value={kpis.designersActive} href="/studio/admin/designers" />
            <KpiTile
              label="Completion Rate"
              value={kpis.completionRate === null ? "—" : `${Math.round(kpis.completionRate * 100)}%`}
            />
          </motion.div>
        )}

        {/* ── Needs Attention ────────────────────────────────────── */}
        {attentionItems.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}
            className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Needs Attention</h2>
              <div className="flex-1 h-px bg-cleo-border" />
              <span className="text-[10px] font-mono text-muted">{attentionTotal} unassigned</span>
            </div>
            <div className="flex flex-col gap-2">
              {attentionItems.map((s) => (
                <Link
                  key={s.id}
                  href={`/studio/admin/sessions/${s.id}?from=/studio/admin`}
                  className="bg-surface border border-gold/30 rounded-xl px-4 py-3 flex items-center gap-4 hover:border-gold/60 transition-colors group"
                >
                  <div className="w-2 h-2 rounded-full bg-gold flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-ink text-sm font-semibold truncate group-hover:text-gold transition-colors">
                      {s.customerName}
                    </p>
                    <p className="text-muted text-xs font-mono truncate">{s.tattoo_style || "No style"} · unassigned</p>
                  </div>
                  <p className="text-muted/60 text-[10px] font-mono flex-shrink-0">
                    {new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                  <svg className="w-4 h-4 text-muted/50 group-hover:text-gold transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── Activity trend + Designer leaderboard ─────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.15 }}
            className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-5 flex flex-col gap-4 min-w-0">
            <div className="flex items-center gap-3">
              <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Sessions — Last {TREND_DAYS} Days</h2>
              <div className="flex-1 h-px bg-cleo-border" />
              <span className="text-[10px] font-mono text-muted">
                {trend.reduce((sum, t) => sum + t.count, 0)} total
              </span>
            </div>
            <div className="flex items-stretch gap-1 sm:gap-1.5 h-32">
              {trend.map((t) => {
                const isToday = t.date === todayKey;
                const pct = (t.count / maxTrendCount) * 100;
                return (
                  <div key={t.date} className="flex-1 min-w-0 flex flex-col items-center group relative">
                    {/* Custom tooltip — full weekday/date/count on hover */}
                    <div className="pointer-events-none absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10 whitespace-nowrap bg-surface-2 border border-cleo-border rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-ink shadow-xl">
                      <span className="text-gold font-bold">{t.count}</span> session{t.count === 1 ? "" : "s"} · {t.weekday}, {t.dateLabel}
                    </div>

                    <div className="w-full flex-1 flex flex-col justify-end items-center gap-1.5">
                      <span className="text-sm font-mono font-bold leading-none text-gold">
                        {t.count}
                      </span>
                      <div
                        className={`w-full rounded-t transition-colors min-h-[3px] ${
                          isToday ? "bg-gold" : "bg-gold/55 group-hover:bg-gold/85"
                        }`}
                        style={{ height: `${pct}%` }}
                      />
                    </div>
                    <span className={`flex items-center gap-0.5 text-xs font-mono mt-1.5 ${isToday ? "text-gold font-bold" : "text-muted/50"}`}>
                      <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <rect x="3" y="5" width="18" height="16" rx="2" />
                        <path strokeLinecap="round" d="M3 10h18M8 3v4M16 3v4" />
                      </svg>
                      {t.dateLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>

          {leaderboard && (
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 }}
              className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-5 flex flex-col gap-3 lg:w-64">
              <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Top Designers (30d)</h2>
              <div className="flex flex-col gap-2.5">
                {leaderboard.map((l, i) => (
                  <Link key={l.designerId} href={`/studio/admin/designers/${l.designerId}`} className="flex items-center gap-2.5 group">
                    <span className="text-[10px] font-mono text-muted/60 w-3 flex-shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-ink text-xs font-semibold truncate group-hover:text-gold transition-colors">{l.name}</p>
                        <span className="text-[10px] font-mono text-muted flex-shrink-0">{l.count}</span>
                      </div>
                      <div className="h-1 bg-cleo-border rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-gold rounded-full" style={{ width: `${(l.count / maxLeaderboardCount) * 100}%` }} />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </motion.div>
          )}
        </div>

        {/* ── Recent Work ────────────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.25 }} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Recent Work</h2>
            <div className="flex-1 h-px bg-cleo-border" />
            <span className="text-[10px] font-mono text-muted">{work.length} of {workTotal}</span>
          </div>

          {work.length === 0 ? (
            <div className="bg-surface border border-cleo-border rounded-xl p-6 text-center">
              <p className="text-muted text-sm">No finalized designs yet.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {work.map((w) => (
                  <Link
                    key={w.id}
                    href={`/studio/admin/sessions/${w.id}?from=/studio/admin`}
                    className="group relative aspect-square rounded-xl overflow-hidden border border-cleo-border hover:border-gold/50 transition-colors bg-surface-2"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={resolveImageSrc(w.imageUrl)} alt={w.styleName ?? "Tattoo"} className="w-full h-full object-cover" loading="lazy" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2.5 pt-6">
                      <p className="text-white text-xs font-cinzel font-bold truncate">{w.customerName}</p>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-white/70 text-[10px] font-mono truncate">{w.designerName}</p>
                        <span className={`text-[9px] font-mono font-bold uppercase flex-shrink-0 ${statusColor(w.status)}`}>{w.status}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
              {hasMoreWork && (
                <button
                  onClick={handleLoadMoreWork}
                  disabled={loadingMoreWork}
                  className="py-2.5 text-center text-xs font-mono uppercase tracking-widest text-gold hover:text-gold-light border border-cleo-border hover:border-gold/40 rounded-xl transition-colors cursor-pointer disabled:opacity-60"
                >
                  {loadingMoreWork ? "Loading…" : "Load More"}
                </button>
              )}
            </>
          )}
        </motion.div>

      </div>
    </div>
  );
}

// Mirrors the real layout's structure/sizing section-by-section so the
// content doesn't visibly jump once the real data swaps in.
function DashboardSkeleton() {
  return (
    <div className="min-h-[100dvh] bg-bg flex flex-col">
      <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 max-w-5xl mx-auto w-full flex flex-col gap-7 sm:gap-8">

        <div>
          <div className="skeleton h-3 w-32 rounded mb-2.5" />
          <div className="skeleton h-7 w-44 rounded" />
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface border border-cleo-border rounded-xl p-4 min-w-0">
              <div className="skeleton h-7 w-12 rounded mb-2" />
              <div className="skeleton h-2.5 w-20 rounded" />
            </div>
          ))}
        </div>

        {/* Needs Attention */}
        <div className="flex flex-col gap-3">
          <div className="skeleton h-3 w-32 rounded" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="bg-surface border border-cleo-border rounded-xl px-4 py-3 flex items-center gap-4">
                <div className="skeleton w-2 h-2 rounded-full flex-shrink-0" />
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <div className="skeleton h-3.5 w-28 rounded" />
                  <div className="skeleton h-2.5 w-40 rounded" />
                </div>
                <div className="skeleton h-2.5 w-10 rounded flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>

        {/* Trend + leaderboard */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4">
          <div className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-5 flex flex-col gap-4 min-w-0">
            <div className="skeleton h-3 w-44 rounded" />
            <div className="flex items-stretch gap-1 sm:gap-1.5 h-32">
              {Array.from({ length: TREND_DAYS }).map((_, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full flex-1 flex flex-col justify-end items-center gap-1">
                    <div className="skeleton h-2 w-3 rounded-sm" />
                    <div className="skeleton w-full rounded-t" style={{ height: `${25 + ((i * 37) % 60)}%` }} />
                  </div>
                  <div className="skeleton h-2 w-4 rounded-sm mt-1" />
                </div>
              ))}
            </div>
          </div>

          <div className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-5 flex flex-col gap-3 lg:w-64">
            <div className="skeleton h-3 w-28 rounded" />
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <div className="skeleton h-2.5 w-3 rounded flex-shrink-0" />
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="skeleton h-3 w-20 rounded" />
                    <div className="skeleton h-1 w-full rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent Work */}
        <div className="flex flex-col gap-4">
          <div className="skeleton h-3 w-28 rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: WORK_PAGE_SIZE }).map((_, i) => (
              <div key={i} className="skeleton aspect-square rounded-xl" />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

function KpiTile({ label, value, href, onClick }: { label: string; value: string | number; href?: string; onClick?: () => void }) {
  const clickable = !!href || !!onClick;
  const inner = (
    <>
      <p className="font-cinzel text-2xl font-black text-gold leading-none">{value}</p>
      <div className="flex items-center justify-between mt-1">
        <p className="text-muted text-[10px] font-mono uppercase tracking-widest truncate">{label}</p>
        {clickable && <span className="text-[10px] font-mono text-muted/60 group-hover:text-gold transition-colors flex-shrink-0">View →</span>}
      </div>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="bg-surface border border-cleo-border rounded-xl p-4 hover:border-gold/40 transition-colors group min-w-0">
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="bg-surface border border-cleo-border rounded-xl p-4 hover:border-gold/40 transition-colors group min-w-0 text-left cursor-pointer w-full">
        {inner}
      </button>
    );
  }
  return <div className="bg-surface border border-cleo-border rounded-xl p-4 min-w-0">{inner}</div>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapWorkRow(r: any): WorkItem {
  const customer = Array.isArray(r.users) ? r.users[0] : r.users;
  const designer = Array.isArray(r.designer) ? r.designer[0] : r.designer;
  const design = Array.isArray(r.tattoo_designs) ? r.tattoo_designs[0] : r.tattoo_designs;
  // The query already restricts the embedded placements to is_finalized=true
  // (mirroring the same filter already applied to tattoo_designs) — these
  // find()s are a defensive fallback, not the primary filter, so a session
  // that somehow has no finalized placement row still falls back to
  // something rather than showing a stale unfinalized attempt.
  const placementRows: { final_composite_url: string | null; is_finalized: boolean }[] =
    Array.isArray(r.placements) ? r.placements : r.placements ? [r.placements] : [];
  const placement = placementRows.find((p) => p.is_finalized) ?? placementRows.find((p) => p.final_composite_url);
  return {
    id: r.id,
    imageUrl: placement?.final_composite_url ?? design?.image_url,
    styleName: design?.style_name ?? null,
    customerName: customer?.first_name ?? "Unknown",
    designerName: designer?.name ?? "Unassigned",
    status: r.status,
    createdAt: r.created_at,
  };
}
