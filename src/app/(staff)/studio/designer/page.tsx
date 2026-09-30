"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";
import { useAppStore } from "@/store/app-store";
import type { StaffMember } from "@/lib/staff-types";

interface CustomerResult {
  id: string;
  first_name: string;
  phone: string;
  session_count: number;
}

interface RecentSession {
  id: string;
  tattoo_style: string | null;
  status: string;
  created_at: string;
  users: { first_name: string; phone: string } | null;
}

const SESSIONS_PAGE_SIZE = 10;
const MIN_QUERY_LENGTH = 1;

function formatPhone(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function DesignerDashboard() {
  const router = useRouter();
  const { setDesignerId, startSession, startSessionForUser } = useAppStore();

  const [staff, setStaff] = useState<StaffMember | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ id: string; first_name: string; phone: string }[] | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [name, setName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [searching, setSearching] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [totalSessionCount, setTotalSessionCount] = useState(0);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const supabase = createSupabaseBrowserClient();

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/studio/login"); return; }

      const { data: staffRow } = await supabase
        .from("staff")
        .select("id, email, name, role, is_active, created_at, avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      if (!staffRow) { router.push("/studio/login"); return; }
      setStaff(staffRow as StaffMember);
      setDesignerId(staffRow.id);

      const { data: sessions, count } = await supabase
        .from("sessions")
        .select("id, tattoo_style, status, created_at, users(first_name, phone)", { count: "exact" })
        .eq("designer_id", staffRow.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .range(0, SESSIONS_PAGE_SIZE - 1);

      const rows = (sessions ?? []) as unknown as RecentSession[];
      setRecentSessions(rows);
      setTotalSessionCount(count ?? rows.length);
      setLoadingRecent(false);
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLoadMoreSessions() {
    if (!staff || loadingMore) return;
    setLoadingMore(true);
    const { data } = await supabase
      .from("sessions")
      .select("id, tattoo_style, status, created_at, users(first_name, phone)")
      .eq("designer_id", staff.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(recentSessions.length, recentSessions.length + SESSIONS_PAGE_SIZE - 1);

    const rows = (data ?? []) as unknown as RecentSession[];
    setRecentSessions((prev) => [...prev, ...rows]);
    setLoadingMore(false);
  }

  // Whether more sessions exist beyond what's currently loaded — compared
  // against the real total count, not "did the last page come back full"
  // (that heuristic breaks when the total is an exact multiple of the page
  // size, e.g. exactly 5 sessions: a full first page looks like "more" when
  // there's actually none left).
  const hasMoreSessions = recentSessions.length < totalSessionCount;

  // Live search as the designer types — searches both name and phone,
  // debounced so it doesn't fire on every keystroke, and only once there's
  // enough typed to make a search worthwhile.
  useEffect(() => {
    setSelectedCustomer(null);
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase.rpc("search_customers", { q });
      setSearchResults(data ?? []);
      if (!data || data.length === 0) {
        // No match — prefill the create-new form from whatever they typed.
        const digitsOnly = q.replace(/\D/g, "");
        const isPhoneShaped = /^[\d\s()+-]+$/.test(q);
        if (isPhoneShaped && digitsOnly.length > 0 && digitsOnly.length <= 10) {
          // A real (possibly partial) phone number — safe to prefill.
          setName("");
          setNewPhone(formatPhone(q));
        } else if (!isPhoneShaped) {
          // Contains letters — treat it as an attempted name.
          setName(q);
          setNewPhone("");
        } else {
          // All digits but more than 10 — not a valid phone number (likely
          // a typo). Truncating it would silently produce a DIFFERENT,
          // real customer's number, so leave both fields blank instead of
          // guessing.
          setName("");
          setNewPhone("");
        }
      }
      setSearching(false);
    }, 500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function handleSelectCustomer(customer: { id: string; first_name: string; phone: string }) {
    setSelecting(true);
    const { count } = await supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", customer.id)
      .eq("status", "completed");
    setSelectedCustomer({ ...customer, session_count: count ?? 0 });
    setSelecting(false);
  }

  async function handleStartExisting() {
    if (!selectedCustomer) return;
    setStarting(true);
    const sessionId = await startSessionForUser(selectedCustomer.id, selectedCustomer.first_name, selectedCustomer.phone);
    router.push(`/${sessionId}/design?from=/studio/designer`);
  }

  async function handleCreateNew(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || newPhone.replace(/\D/g, "").length < 10) return;
    setStarting(true);
    const { sessionId, userId } = await startSession(name.trim(), newPhone);

    if (userId && !sessionId) {
      // Existing user detected mid-flow — go to their dashboard
      router.push(`/customer/${userId}`);
    } else if (sessionId) {
      router.push(`/${sessionId}/design?from=/studio/designer`);
    }
  }

  async function handleLogout() {
    // scope: "local" clears this device's session without a server round
    // trip — a dropped connection there must never leave the cookie intact.
    await supabase.auth.signOut({ scope: "local" });
    setDesignerId(null);
    router.push("/studio/login");
    router.refresh();
  }

  function handleGoToCustomer() {
    if (selectedCustomer) {
      router.push(`/customer/${selectedCustomer.id}?from=/studio/designer`);
    }
  }

  const statusColor = (s: string) =>
    s === "completed" ? "text-success" : s === "abandoned" ? "text-error" : "text-gold";

  return (
    <main className="min-h-[100dvh] bg-bg flex flex-col">
      {/* Header */}
      <header className="px-4 sm:px-6 pt-5 pb-4 border-b border-cleo-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 relative flex-shrink-0">
            <Image src="/cleopatra-logo.svg" alt="Cleopatra" fill className="object-contain" />
          </div>
          <div>
            <p className="font-cinzel text-[11px] font-bold tracking-[0.15em] text-gold uppercase leading-none">
              Cleopatra Ink
            </p>
            <p className="text-[10px] font-mono text-muted tracking-wider leading-none mt-0.5">Designer Portal</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {staff && (
            <Link href="/studio/designer/settings" className="hidden sm:flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-full bg-gold/10 border border-gold/30 group-hover:border-gold transition-colors flex items-center justify-center overflow-hidden flex-shrink-0 relative">
                {staff.avatar_url ? (
                  <Image src={staff.avatar_url} alt={staff.name} fill unoptimized className="object-cover" />
                ) : (
                  <span className="font-cinzel text-xs font-black text-gold">{staff.name.charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="flex flex-col items-end">
                <p className="text-ink text-sm font-semibold leading-none group-hover:text-gold transition-colors">{staff.name}</p>
                <p className="text-muted text-[10px] font-mono tracking-wider uppercase mt-0.5">Designer</p>
              </div>
            </Link>
          )}
          <button
            onClick={handleLogout}
            className="text-muted hover:text-error transition-colors text-xs font-mono tracking-wider px-3 py-2 rounded-lg border border-cleo-border hover:border-error/40 cursor-pointer"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="flex-1 px-4 sm:px-6 py-6 sm:py-8 max-w-2xl mx-auto w-full flex flex-col gap-7">
        {/* Welcome */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-gold text-[11px] font-mono tracking-[0.2em] uppercase mb-1">Welcome back</p>
          <h1 className="font-cinzel text-2xl sm:text-3xl font-black text-ink">
            {staff?.name ?? "Designer"}
          </h1>
        </motion.div>

        {/* Customer Intake Card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="bg-surface border border-cleo-border rounded-2xl p-5 sm:p-6 flex flex-col gap-5"
        >
          <div>
            <h2 className="font-cinzel text-sm font-bold tracking-[0.15em] text-gold uppercase">Customer Lookup</h2>
            <p className="text-muted text-xs mt-1">Search by name or phone number to find their account, or create a new one.</p>
          </div>

          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or phone number…"
              className="w-full bg-bg border border-cleo-border rounded-xl px-4 py-3 text-ink font-mono text-base placeholder:text-muted/40 focus:outline-none focus:border-gold transition-colors"
            />
            {searching && (
              <p className="text-muted text-xs font-mono flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-gold border-t-transparent rounded-full animate-spin inline-block" />
                Searching…
              </p>
            )}
          </div>

          <AnimatePresence mode="wait">
            {/* Multiple/partial matches — pick one */}
            {!selectedCustomer && searchResults && searchResults.length > 0 && (
              <motion.div
                key="results"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-2 pt-1 border-t border-cleo-border"
              >
                {searchResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelectCustomer(c)}
                    disabled={selecting}
                    className="flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border border-cleo-border hover:border-gold/40 transition-colors cursor-pointer disabled:opacity-60"
                  >
                    <div className="w-8 h-8 rounded-full bg-gold/10 border border-gold/20 flex items-center justify-center flex-shrink-0">
                      <span className="font-cinzel text-xs font-black text-gold">
                        {c.first_name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-ink text-sm font-semibold truncate">{c.first_name}</p>
                      <p className="text-muted text-xs font-mono truncate">{c.phone}</p>
                    </div>
                  </button>
                ))}
              </motion.div>
            )}

            {/* Existing customer selected */}
            {selectedCustomer && (
              <motion.div
                key="found"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-3 pt-1 border-t border-cleo-border"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center flex-shrink-0">
                    <span className="font-cinzel text-base font-black text-gold">
                      {selectedCustomer.first_name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="text-ink font-semibold">{selectedCustomer.first_name}</p>
                    <p className="text-muted text-xs font-mono">
                      {selectedCustomer.phone} · {selectedCustomer.session_count} completed {selectedCustomer.session_count === 1 ? "session" : "sessions"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleStartExisting}
                    disabled={starting}
                    className="flex-1 py-3 bg-gold text-bg font-cinzel font-bold text-sm tracking-[0.08em] uppercase rounded-xl border border-gold hover:bg-gold-light transition-colors disabled:opacity-60 cursor-pointer"
                  >
                    {starting ? "Starting…" : "✦ Start New Design"}
                  </button>
                  <button
                    onClick={handleGoToCustomer}
                    className="px-4 py-3 bg-transparent text-gold font-cinzel font-bold text-sm tracking-[0.08em] uppercase rounded-xl border border-gold/40 hover:border-gold hover:bg-gold/5 transition-colors cursor-pointer"
                  >
                    History
                  </button>
                </div>
              </motion.div>
            )}

            {/* No matches — show create form */}
            {searchResults && searchResults.length === 0 && (
              <motion.form
                key="not_found"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                onSubmit={handleCreateNew}
                className="flex flex-col gap-3 pt-1 border-t border-cleo-border"
              >
                <p className="text-muted text-xs">
                  No account found. Enter the customer&apos;s name and phone to create one.
                </p>
                <input
                  type="text"
                  placeholder="Customer full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-bg border border-cleo-border rounded-xl px-4 py-3 text-ink text-base placeholder:text-muted/40 focus:outline-none focus:border-gold transition-colors"
                />
                <input
                  type="tel"
                  inputMode="numeric"
                  placeholder="(555) 000-0000"
                  value={newPhone}
                  onChange={(e) => setNewPhone(formatPhone(e.target.value))}
                  className="bg-bg border border-cleo-border rounded-xl px-4 py-3 text-ink font-mono text-base placeholder:text-muted/40 focus:outline-none focus:border-gold transition-colors"
                />
                <button
                  type="submit"
                  disabled={starting || !name.trim() || newPhone.replace(/\D/g, "").length < 10}
                  className="py-3 bg-gold text-bg font-cinzel font-bold text-sm tracking-[0.08em] uppercase rounded-xl border border-gold hover:bg-gold-light transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                  {starting ? "Creating…" : "✦ Create Account & Start Design"}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Recent Sessions */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="flex flex-col gap-4"
        >
          <div className="flex items-center gap-3">
            <h2 className="font-cinzel text-sm font-bold tracking-[0.18em] text-muted uppercase">Total Sessions</h2>
            <div className="flex-1 h-px bg-cleo-border" />
            {!loadingRecent && (
              <span className="text-[10px] font-mono text-muted">
                {recentSessions.length} of {totalSessionCount}
              </span>
            )}
          </div>

          {loadingRecent ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-surface border border-cleo-border rounded-xl px-4 py-3 flex items-center gap-4">
                  <div className="skeleton w-8 h-8 rounded-full flex-shrink-0" />
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="skeleton h-3.5 w-24 rounded" />
                    <div className="skeleton h-2.5 w-32 rounded" />
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <div className="skeleton h-2.5 w-12 rounded" />
                    <div className="skeleton h-2.5 w-10 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentSessions.length === 0 ? (
            <div className="bg-surface border border-cleo-border rounded-2xl p-8 text-center">
              <p className="text-muted text-sm">No sessions yet. Start your first design above.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {recentSessions.map((s, i) => {
                const customer = Array.isArray(s.users) ? s.users[0] : s.users;
                return (
                  <motion.button
                    key={s.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    onClick={() => router.push(`/studio/sessions/${s.id}`)}
                    className="bg-surface border border-cleo-border rounded-xl px-4 py-3 text-left hover:border-gold/40 transition-colors flex items-center gap-4 cursor-pointer group"
                  >
                    <div className="w-8 h-8 rounded-full bg-gold/10 border border-gold/20 flex items-center justify-center flex-shrink-0">
                      <span className="font-cinzel text-xs font-black text-gold">
                        {customer?.first_name?.charAt(0).toUpperCase() ?? "?"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-ink text-sm font-semibold truncate">{customer?.first_name ?? "Unknown"}</p>
                      <p className="text-muted text-xs font-mono truncate">{s.tattoo_style || "No style set"}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-xs font-mono font-bold uppercase ${statusColor(s.status)}`}>{s.status}</p>
                      <p className="text-muted/60 text-[10px] font-mono">
                        {new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </p>
                    </div>
                    <svg className="w-4 h-4 text-muted/30 group-hover:text-gold/60 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </motion.button>
                );
              })}
              {hasMoreSessions && (
                <button
                  onClick={handleLoadMoreSessions}
                  disabled={loadingMore}
                  className="mt-1 py-2.5 text-center text-xs font-mono uppercase tracking-widest text-gold hover:text-gold-light border border-cleo-border hover:border-gold/40 rounded-xl transition-colors cursor-pointer disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load More"}
                </button>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </main>
  );
}
