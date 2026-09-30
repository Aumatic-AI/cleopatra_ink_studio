"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";
import { useAppStore } from "@/store/app-store";
import { resolveBackUrl } from "@/lib/auth-utils";
import FilterChips from "@/components/ui/FilterChips";

const supabase = createSupabaseBrowserClient();

function formatPhone(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function TattooThumb({ url, alt }: { url: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <span className="text-2xl text-muted/30">✦</span>
      </div>
    );
  }
  return (
    <Image
      src={url}
      alt={alt}
      fill
      unoptimized
      sizes="96px"
      className="object-cover"
      onError={() => setErrored(true)}
    />
  );
}

interface UserProfile {
  first_name: string;
  phone: string;
  created_at: string;
}

interface CompletedSession {
  id: string;
  tattoo_style: string | null;
  tattoo_description: string | null;
  flow_type: "ai_design" | "rework" | "direct";
  completed_at: string;
  design: { image_url: string; style_name: string | null } | null;
  placement: { placement_text: string | null; final_composite_url: string | null } | null;
  // Rework only — the original photo of the existing tattoo, from the first
  // chat turn (there's no dedicated column for it, see SessionOverview).
  sourcePhoto: string | null;
}

type HistoryFilter = "all" | "ai_design" | "rework" | "direct";

interface ActiveSession {
  id: string;
  tattoo_style: string | null;
  tattoo_description: string | null;
  created_at: string;
  flow_type: "ai_design" | "rework" | "direct";
  hasDesign: boolean;
  hasChatMessages: boolean;
  hasPlacement: boolean;
}

// Resume at whichever screen the session actually got to — see the matching
// (and more heavily commented) version of this logic in SessionOverview.tsx.
// `from` is only consumed by the Design page's own back button (Chat and
// Placement resolve their back target deterministically) — harmless to pass
// along regardless of which of the three this resolves to.
function resumeUrl(session: ActiveSession, from: string): string {
  const suffix = `?from=${encodeURIComponent(from)}`;
  if (session.flow_type === "direct") {
    return session.hasDesign ? `/${session.id}/placement` : `/${session.id}/design${suffix}`;
  }
  if (!session.hasChatMessages) return `/${session.id}/design${suffix}`;
  if (session.flow_type === "ai_design" && session.hasPlacement) return `/${session.id}/placement`;
  return `/${session.id}/chat`;
}

function CustomerDetailSkeleton() {
  return (
    <div className="min-h-[100dvh] bg-bg flex flex-col">
      <header className="px-4 sm:px-6 pt-6 sm:pt-8 pb-4 sm:pb-6 border-b border-cleo-border flex items-center justify-between gap-3">
        <div className="skeleton h-3 w-14 rounded" />
        <div className="skeleton h-3 w-24 rounded hidden sm:block" />
        <div className="skeleton h-8 w-28 rounded-lg" />
      </header>

      <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6 sm:gap-8 max-w-2xl mx-auto w-full">
        <div className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-6 flex items-center gap-3 sm:gap-5">
          <div className="skeleton w-12 h-12 sm:w-16 sm:h-16 rounded-full flex-shrink-0" />
          <div className="flex flex-col gap-1.5 flex-1">
            <div className="skeleton h-4 w-32 rounded" />
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton h-2.5 w-28 rounded" />
          </div>
          <div className="skeleton h-8 w-10 rounded flex-shrink-0" />
        </div>

        <div className="flex flex-col gap-3">
          <div className="skeleton h-3 w-28 rounded" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="bg-surface border border-cleo-border rounded-2xl p-3 sm:p-4 flex gap-3 sm:gap-4">
                <div className="flex gap-2 flex-shrink-0">
                  <div className="skeleton w-20 h-20 sm:w-24 sm:h-24 rounded-xl" />
                  <div className="skeleton w-20 h-20 sm:w-24 sm:h-24 rounded-xl" />
                </div>
                <div className="flex-1 flex flex-col gap-1.5 justify-center">
                  <div className="skeleton h-3.5 w-28 rounded" />
                  <div className="skeleton h-2.5 w-40 rounded" />
                  <div className="skeleton h-2.5 w-20 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerDashboardInner() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const startSessionForUser = useAppStore((s) => s.startSessionForUser);
  const setDesignerId = useAppStore((s) => s.setDesignerId);

  const fromParam = searchParams.get("from");
  // backUrl/backLabel are role-validated — set in useEffect after role is confirmed
  const [backUrl, setBackUrl] = useState("/studio/designer");
  const [backLabel, setBackLabel] = useState("Dashboard");

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<CompletedSession[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [startingSession, setStartingSession] = useState(false);

  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    async function load() {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) { router.push("/studio/login"); return; }
      const { data: staffRow } = await supabase
        .from("staff").select("role").eq("id", authUser.id).maybeSingle();
      const role = staffRow?.role as "admin" | "designer" | undefined ?? null;
      // Whoever starts the session (admin or designer) is who handled it —
      // designer_id is really "handled by", not designer-only. Without this,
      // a session started by an admin here would save with no staff
      // attached at all and show "Unassigned" in the session details.
      setDesignerId(authUser.id);
      const defaultBack = role === "admin" ? "/studio/admin" : "/studio/designer";
      const defaultLabel = role === "admin" ? "Admin" : "Dashboard";
      const { backUrl: resolvedUrl, backLabel: resolvedLabel } =
        resolveBackUrl(fromParam, role, defaultBack, defaultLabel);
      setBackUrl(resolvedUrl);
      setBackLabel(resolvedLabel);

      const [userRes, sessionsRes, activeRes] = await Promise.all([
        supabase
          .from("users")
          .select("first_name, phone, created_at")
          .eq("id", userId)
          .maybeSingle(),
        supabase
          .from("sessions")
          .select(`
            id, tattoo_style, tattoo_description, flow_type, completed_at,
            tattoo_designs!inner(image_url, style_name),
            placements(placement_text, final_composite_url)
          `)
          .eq("user_id", userId)
          .eq("status", "completed")
          .eq("tattoo_designs.is_finalized", true)
          .is("deleted_at", null)
          .order("completed_at", { ascending: false }),
        supabase
          .from("sessions")
          .select("id, tattoo_style, tattoo_description, created_at, flow_type, tattoo_designs(id), chat_messages(id), placements(id)")
          .eq("user_id", userId)
          .eq("status", "active")
          .is("deleted_at", null)
          .order("created_at", { ascending: false }),
      ]);

      if (userRes.error || !userRes.data) { setNotFound(true); setLoading(false); return; }
      setProfile(userRes.data);

      const rawSessions = sessionsRes.data;
      if (rawSessions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mapped: CompletedSession[] = rawSessions.map((s: any) => ({
          id: s.id,
          tattoo_style: s.tattoo_style,
          tattoo_description: s.tattoo_description,
          flow_type: s.flow_type ?? "ai_design",
          completed_at: s.completed_at,
          design: Array.isArray(s.tattoo_designs) ? s.tattoo_designs[0] ?? null : s.tattoo_designs,
          placement: Array.isArray(s.placements)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? s.placements.find((p: any) => p.final_composite_url) ?? s.placements[0] ?? null
            : s.placements,
          sourcePhoto: null,
        }));

        // Rework's original reference photo lives on the first chat turn, not
        // a session column — fetch it for every rework session in one batch
        // instead of one query per row.
        const reworkIds = mapped.filter((s) => s.flow_type === "rework").map((s) => s.id);
        if (reworkIds.length > 0) {
          const { data: firstTurns } = await supabase
            .from("chat_messages")
            .select("session_id, image_urls, created_at")
            .in("session_id", reworkIds)
            .eq("role", "user")
            .order("created_at", { ascending: true });

          const sourcePhotoBySession = new Map<string, string>();
          for (const row of firstTurns ?? []) {
            if (!sourcePhotoBySession.has(row.session_id) && row.image_urls?.[0]) {
              sourcePhotoBySession.set(row.session_id, row.image_urls[0]);
            }
          }
          for (const s of mapped) {
            if (s.flow_type === "rework") s.sourcePhoto = sourcePhotoBySession.get(s.id) ?? null;
          }
        }

        setSessions(mapped);
      }

      const rawActive = activeRes.data;
      if (rawActive) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mappedActive: ActiveSession[] = rawActive.map((s: any) => ({
          id: s.id,
          tattoo_style: s.tattoo_style,
          tattoo_description: s.tattoo_description,
          created_at: s.created_at,
          flow_type: s.flow_type ?? "ai_design",
          hasDesign: Array.isArray(s.tattoo_designs) ? s.tattoo_designs.length > 0 : !!s.tattoo_designs,
          hasChatMessages: Array.isArray(s.chat_messages) ? s.chat_messages.length > 0 : !!s.chat_messages,
          hasPlacement: Array.isArray(s.placements) ? s.placements.length > 0 : !!s.placements,
        }));
        setActiveSessions(mappedActive);
      }

      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleNewTattoo() {
    if (!profile) return;
    setStartingSession(true);
    const sessionId = await startSessionForUser(userId, profile.first_name, profile.phone);
    router.push(`/${sessionId}/design?from=${encodeURIComponent(`/customer/${userId}`)}`);
  }

  function openEditProfile() {
    if (!profile) return;
    setEditName(profile.first_name);
    setEditPhone(profile.phone);
    setSaveError("");
    setEditingProfile(true);
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    const trimmedName = editName.trim();
    const digits = editPhone.replace(/\D/g, "");
    if (!trimmedName || digits.length < 10) return;

    setSavingProfile(true);
    setSaveError("");
    const { error } = await supabase
      .from("users")
      .update({ first_name: trimmedName, phone: editPhone })
      .eq("id", userId);

    if (error) {
      // Postgres unique_violation — this phone already belongs to another customer.
      setSaveError(
        error.code === "23505"
          ? "That phone number is already used by another customer."
          : "Couldn't save changes — please try again."
      );
      setSavingProfile(false);
      return;
    }

    setProfile({ ...profile, first_name: trimmedName, phone: editPhone });
    setSavingProfile(false);
    setEditingProfile(false);
  }

  if (loading) {
    return <CustomerDetailSkeleton />;
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-6 px-4">
        <p className="font-cinzel text-xl text-ink">Customer not found.</p>
        <Link href={backUrl} className="text-gold underline font-mono text-sm">← {backLabel}</Link>
      </div>
    );
  }

  const memberYear = profile ? new Date(profile.created_at).getFullYear() : "";

  return (
    <div className="min-h-[100dvh] bg-bg flex flex-col">
      {/* Header */}
      <header className="px-4 sm:px-6 pt-6 sm:pt-8 pb-4 sm:pb-6 border-b border-cleo-border flex items-center justify-between gap-3">
        <button
          onClick={() => router.push(backUrl)}
          aria-label="Back"
          className="flex items-center gap-1.5 sm:gap-2 text-muted hover:text-gold transition-colors text-xs sm:text-sm font-mono tracking-wider flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span className="hidden sm:inline">{backLabel}</span>
        </button>

        <p className="font-cinzel text-[11px] sm:text-xs tracking-[0.2em] text-gold uppercase truncate">
          Cleopatra Ink
        </p>

        <motion.button
          onClick={handleNewTattoo}
          disabled={startingSession}
          whileHover={{ scale: startingSession ? 1 : 1.05 }}
          whileTap={{ scale: startingSession ? 1 : 0.95 }}
          className="bg-gold text-bg font-cinzel font-bold text-xs tracking-[0.08em] uppercase px-4 py-2 rounded-lg border border-gold hover:bg-gold-light transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {startingSession ? "…" : "+ New Tattoo"}
        </motion.button>
      </header>

      <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6 sm:gap-8 max-w-2xl mx-auto w-full">
        {/* Profile card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="bg-surface border border-cleo-border rounded-2xl p-4 sm:p-6 flex flex-col gap-4"
        >
          <div className="flex items-center gap-3 sm:gap-5">
            <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center flex-shrink-0">
              <span className="font-cinzel text-xl sm:text-2xl font-black text-gold">
                {profile?.first_name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 sm:gap-1 min-w-0">
              <h1 className="font-cinzel text-base sm:text-xl font-black text-ink tracking-wide truncate">{profile?.first_name}</h1>
              <p className="text-muted text-xs sm:text-sm font-mono truncate">{profile?.phone}</p>
              <p className="text-muted/60 text-[10px] sm:text-xs font-mono tracking-widest">MEMBER SINCE {memberYear}</p>
            </div>
            <div className="ml-auto flex flex-col items-end gap-2 flex-shrink-0">
              <div className="text-right">
                <p className="font-cinzel text-xl sm:text-2xl font-black text-gold leading-none">{sessions.length}</p>
                <p className="text-muted text-[10px] sm:text-xs tracking-widest uppercase font-mono mt-0.5">
                  {sessions.length === 1 ? "Tattoo" : "Tattoos"}
                </p>
              </div>
              {!editingProfile && (
                <button
                  onClick={openEditProfile}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gold/40 text-gold text-xs font-cinzel font-bold uppercase tracking-wider hover:bg-gold/10 hover:border-gold transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit
                </button>
              )}
            </div>
          </div>

          {editingProfile && (
            <motion.form
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              onSubmit={handleSaveProfile}
              className="flex flex-col gap-3 pt-3 border-t border-cleo-border"
            >
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Customer full name"
                autoFocus
                className="bg-bg border border-cleo-border rounded-xl px-4 py-3 text-ink text-base placeholder:text-muted/40 focus:outline-none focus:border-gold transition-colors"
              />
              <input
                type="tel"
                inputMode="numeric"
                value={editPhone}
                onChange={(e) => setEditPhone(formatPhone(e.target.value))}
                placeholder="(555) 000-0000"
                className="bg-bg border border-cleo-border rounded-xl px-4 py-3 text-ink font-mono text-base placeholder:text-muted/40 focus:outline-none focus:border-gold transition-colors"
              />
              {saveError && <p className="text-error text-xs">{saveError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={savingProfile || !editName.trim() || editPhone.replace(/\D/g, "").length < 10}
                  className="flex-1 py-2.5 bg-gold text-bg font-cinzel font-bold text-xs tracking-[0.08em] uppercase rounded-xl border border-gold hover:bg-gold-light transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {savingProfile ? "Saving…" : "Save Changes"}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingProfile(false); setSaveError(""); }}
                  className="px-4 py-2.5 bg-transparent text-muted font-cinzel font-bold text-xs tracking-[0.08em] uppercase rounded-xl border border-cleo-border hover:border-ink/40 hover:text-ink transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </motion.form>
          )}
        </motion.div>

        {/* In-progress sessions — not yet completed/finalized, easy to lose track of otherwise */}
        {activeSessions.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-gold uppercase">In Progress</h2>
              <div className="flex-1 h-px bg-cleo-border" />
            </div>
            <div className="flex flex-col gap-2">
              {activeSessions.map((session, i) => {
                const continueUrl = resumeUrl(session, `/customer/${userId}`);
                const dateLabel = new Date(session.created_at).toLocaleDateString("en-US", {
                  year: "numeric", month: "short", day: "numeric",
                });
                return (
                  <motion.button
                    key={session.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: i * 0.05 }}
                    onClick={() => router.push(continueUrl)}
                    className="bg-gold/5 border border-gold/30 rounded-xl px-4 py-3 flex items-center gap-3 text-left hover:border-gold/60 transition-colors cursor-pointer group"
                  >
                    <div className="w-2 h-2 rounded-full bg-gold flex-shrink-0 animate-pulse" />
                    <div className="flex-1 min-w-0">
                      <p className="font-cinzel text-xs font-bold tracking-[0.1em] text-ink uppercase truncate">
                        {session.tattoo_style ?? "Custom Design"}
                      </p>
                      {session.tattoo_description && (
                        <p className="text-muted text-xs truncate">{session.tattoo_description}</p>
                      )}
                      <p className="text-muted/50 text-[10px] font-mono mt-0.5">Started {dateLabel}</p>
                    </div>
                    <span className="flex-shrink-0 h-8 px-3 rounded-lg bg-gold text-bg font-cinzel font-bold text-[10px] tracking-[0.1em] uppercase flex items-center group-hover:bg-gold-light transition-colors">
                      Continue
                    </span>
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}

        {/* Tattoo history */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Tattoo History</h2>
            <div className="flex-1 h-px bg-cleo-border min-w-8" />
            {sessions.length > 0 && (
              <FilterChips
                options={[
                  { value: "all", label: "All" },
                  { value: "ai_design", label: "AI Design" },
                  { value: "direct", label: "Uploaded" },
                  { value: "rework", label: "Rework" },
                ]}
                value={historyFilter}
                onChange={setHistoryFilter}
              />
            )}
          </div>

          {(() => {
            const filteredSessions = historyFilter === "all"
              ? sessions
              : sessions.filter((s) => s.flow_type === historyFilter);

            if (sessions.length > 0 && filteredSessions.length === 0) {
              const filterLabel = historyFilter === "ai_design" ? "AI Design" : historyFilter === "direct" ? "Uploaded" : "Rework";
              return (
                <div className="bg-surface border border-cleo-border rounded-2xl p-8 text-center">
                  <p className="text-muted text-sm">No {filterLabel} sessions yet.</p>
                </div>
              );
            }

            return filteredSessions.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="bg-surface border border-cleo-border rounded-2xl p-10 flex flex-col items-center gap-4 text-center"
            >
              <div className="w-14 h-14 rounded-full bg-gold/5 border border-gold/20 flex items-center justify-center">
                <span className="text-2xl text-gold/40">✦</span>
              </div>
              <p className="text-muted text-sm">No completed sessions yet.</p>
              <motion.button
                onClick={handleNewTattoo}
                disabled={startingSession}
                whileHover={{ scale: startingSession ? 1 : 1.03 }}
                whileTap={{ scale: 0.97 }}
                className="bg-gold text-bg font-cinzel font-bold text-sm tracking-[0.08em] uppercase px-6 py-3 rounded-xl border border-gold hover:bg-gold-light transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
              >
                {startingSession ? "Starting…" : "Start Your First Design"}
              </motion.button>
            </motion.div>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredSessions.map((session, i) => {
                const isRework = session.flow_type === "rework";
                const designUrl = session.design?.image_url;
                const bodyUrl = session.placement?.final_composite_url;
                const dateLabel = new Date(session.completed_at).toLocaleDateString("en-US", {
                  year: "numeric", month: "short", day: "numeric",
                });

                return (
                  <motion.button
                    key={session.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: i * 0.07 }}
                    whileHover={{ y: -2 }}
                    onClick={() => router.push(`/studio/sessions/${session.id}?from=/customer/${userId}`)}
                    className="bg-surface border border-cleo-border rounded-2xl overflow-hidden text-left hover:border-gold/40 transition-colors cursor-pointer group"
                  >
                    <div className="p-3 sm:p-4 flex flex-col sm:flex-row gap-3 sm:gap-4">
                      {/* Thumbnail(s) — rework shows original + result, AI Design shows design + on-body */}
                      <div className="flex gap-2 flex-shrink-0">
                        {(isRework
                          ? [{ url: session.sourcePhoto ?? undefined, label: "Original" }, { url: designUrl, label: "Result" }]
                          : [{ url: designUrl, label: "Design" }, { url: bodyUrl, label: "On Body" }]
                        ).map(({ url, label }) => (
                          <div key={label} className="flex flex-col gap-1.5 items-center">
                            <div className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-xl overflow-hidden bg-surface-2 border border-cleo-border group-hover:border-gold/30 transition-colors">
                              {url ? (
                                <TattooThumb url={url} alt={label} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <span className="text-xl text-muted/30">✦</span>
                                </div>
                              )}
                            </div>
                            <span className="text-[9px] font-mono tracking-[0.18em] text-muted uppercase">{label}</span>
                          </div>
                        ))}
                      </div>

                      {/* Info */}
                      <div className="flex-1 flex flex-col justify-between min-w-0 gap-2">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-cinzel text-xs font-bold tracking-[0.15em] text-gold uppercase truncate">
                              {session.tattoo_style ?? session.design?.style_name ?? "Custom Design"}
                            </span>
                            {isRework && (
                              <span className="text-[9px] font-mono uppercase tracking-wider bg-gold/10 text-gold border border-gold/30 px-1.5 py-0.5 rounded-full flex-shrink-0">
                                Rework
                              </span>
                            )}
                            {session.flow_type === "direct" && (
                              <span className="text-[9px] font-mono uppercase tracking-wider bg-gold/10 text-gold border border-gold/30 px-1.5 py-0.5 rounded-full flex-shrink-0">
                                Uploaded
                              </span>
                            )}
                          </div>
                          {session.tattoo_description && (
                            <p className="text-ink text-sm leading-snug line-clamp-2">{session.tattoo_description}</p>
                          )}
                          {session.placement?.placement_text && (
                            <p className="text-muted text-xs flex items-center gap-1.5">
                              <svg className="w-3 h-3 text-gold/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                              {session.placement.placement_text}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-muted/50 text-xs font-mono">{dateLabel}</p>
                          <span className="text-[10px] font-cinzel tracking-widest text-muted/40 uppercase opacity-0 group-hover:opacity-100 transition-opacity">
                            View →
                          </span>
                        </div>
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          );
          })()}
        </div>
      </div>

      {/* Sticky mobile CTA */}
      {sessions.length > 0 && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-bg/95 backdrop-blur-md border-t border-cleo-border px-4 pt-3 pb-safe">
          <button
            onClick={handleNewTattoo}
            disabled={startingSession}
            className="w-full py-3.5 rounded-xl font-cinzel font-bold text-sm tracking-[0.08em] uppercase bg-gold text-bg border border-gold cursor-pointer shadow-[0_0_18px_rgba(201,168,76,0.25)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {startingSession ? "Starting…" : "✦ Start New Tattoo"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function CustomerDashboard() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <CustomerDashboardInner />
    </Suspense>
  );
}
