"use client";

import { useEffect, useState, cloneElement } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";

interface AdminIdentity {
  name: string;
  avatar_url: string | null;
}

const NAV_ITEMS = [
  {
    href: "/studio/admin",
    label: "Dashboard",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/studio/admin/customers",
    label: "Customers",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-3.13a4 4 0 10-8 0 4 4 0 008 0zm6 3a4 4 0 10-8 0" />
      </svg>
    ),
  },
  {
    href: "/studio/admin/designers",
    label: "Designers",
    // Paintbrush — reads as "the creative staff" on its own, unlike the
    // generic people icon already used for Customers.
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.49 4.49 0 003.498 1.307 4.491 4.491 0 001.307-3.497c0-.398-.077-.778-.22-1.128Zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
  },
  {
    href: "/studio/admin/settings",
    label: "Settings",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

// Kept separate from Settings/Designers/etc. — it's the only nav item that
// carries an unseen-count badge, so render sites check against this href
// rather than a generic flag on every item.
const TRASH_HREF = "/studio/admin/trash";
const TRASH_NAV_ITEM = {
  href: TRASH_HREF,
  label: "Recently Deleted",
  icon: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  ),
};
const ALL_NAV_ITEMS = [...NAV_ITEMS, TRASH_NAV_ITEM];

function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-gold text-bg text-[9px] font-mono font-bold flex items-center justify-center leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function isActive(pathname: string, href: string) {
  if (href === "/studio/admin") return pathname === "/studio/admin";
  return pathname.startsWith(href);
}

/**
 * Shows the admin sidebar/nav shell around `children` — but only for an
 * actual admin session. Every other case (designer, no session, the login
 * page) renders children directly with no shell.
 *
 * Role-driven rather than route-driven on purpose: several pages (customer
 * profile, session detail) are reached by both roles depending on where the
 * user navigated from, so a layout scoped to one folder can't correctly
 * show/hide the sidebar for those shared pages — only the actual logged-in
 * role can. The check itself runs entirely in the browser (same pattern as
 * every other page in the app) rather than trusting a server-computed value,
 * so it isn't affected by server-side Supabase connectivity issues.
 */
export default function AdminSidebarShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  // undefined = role check still in flight (fresh app load); null = confirmed
  // non-admin/no session. Kept distinct so the splash below only ever shows
  // once, on the very first load — not on every in-app navigation.
  const [admin, setAdmin] = useState<AdminIdentity | null | undefined>(undefined);
  const [trashCount, setTrashCount] = useState(0);

  // Unseen-count badge for Recently Deleted — re-fetched on every navigation
  // (not just once at mount) so it clears once the admin has actually opened
  // that tab and updated their trash_last_viewed_at, and stays accurate if
  // a designer soft-deletes something else while the admin is elsewhere.
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: staffRow } = await supabase
        .from("staff").select("trash_last_viewed_at").eq("id", user.id).maybeSingle();

      let query = supabase.from("sessions").select("id", { count: "exact", head: true }).not("deleted_at", "is", null);
      if (staffRow?.trash_last_viewed_at) query = query.gt("deleted_at", staffRow.trash_last_viewed_at);

      const { count } = await query;
      if (!cancelled) setTrashCount(count ?? 0);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, pathname]);

  useEffect(() => {
    // if (pathname === "/studio/login") return;
    let cancelled = false;

    async function check() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { if (!cancelled) setAdmin(null); return; }

      const { data: staff } = await supabase
        .from("staff")
        .select("name, role, is_active, avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      if (!cancelled) setAdmin(staff && staff.role === "admin" && staff.is_active ? staff : null);
    }
    check();

    // Re-validate on any real auth change (sign-in, sign-out, token refresh)
    // — a one-time mount check alone goes stale the moment a different
    // account signs in in the same tab (e.g. admin logs out, a designer logs
    // in): the shell would otherwise keep showing the previous session's
    // sidebar since this effect never re-runs on its own.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      check();
    });

    return () => { cancelled = true; subscription.unsubscribe(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pathname === "/studio/login") {
    return <>{children}</>;
  }

  // Brief branded splash while the very first role check is in flight — this
  // shell lives in the root layout and mounts once per hard page load, so
  // this only ever appears on a fresh app load, never on in-app navigation.
  // Same markup as the root "/" splash (src/app/page.tsx) — that one only
  // ever showed for visits to "/" itself, never for a deep link straight
  // into e.g. /studio/admin/sessions/xyz, which is what this covers.
  if (admin === undefined) {
    return (
      <main className="min-h-[100dvh] bg-bg flex flex-col items-center justify-center px-5 relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg,#c9a84c 0px,#c9a84c 1px,transparent 1px,transparent 60px),repeating-linear-gradient(90deg,#c9a84c 0px,#c9a84c 1px,transparent 1px,transparent 60px)",
          }}
        />
        {[
          "top-6 left-6 border-t-2 border-l-2 rounded-tl",
          "top-6 right-6 border-t-2 border-r-2 rounded-tr",
          "bottom-6 left-6 border-b-2 border-l-2 rounded-bl",
          "bottom-6 right-6 border-b-2 border-r-2 rounded-br",
        ].map((cls) => (
          <div key={cls} className={`absolute w-10 h-10 border-gold/20 ${cls}`} />
        ))}

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center gap-6 z-10"
        >
          <div className="w-40 h-40 sm:w-56 sm:h-56 relative drop-shadow-2xl">
            <Image
              src="/cleopatra-logo.svg"
              alt="Cleopatra Ink Studio"
              fill
              className="object-contain"
              priority
            />
          </div>

          <div className="text-center flex flex-col gap-1">
            <h1 className="font-cinzel text-4xl sm:text-5xl font-black tracking-[0.12em] text-ink uppercase leading-none">
              Cleopatra
            </h1>
            <h2 className="font-cinzel text-xl sm:text-2xl font-bold tracking-[0.22em] text-gold uppercase">
              Ink Studio
            </h2>
            <div className="flex items-center gap-3 my-2">
              <div className="flex-1 h-px bg-gradient-to-r from-transparent to-gold/40" />
              <div className="w-1 h-1 rounded-full bg-gold rotate-45" />
              <div className="flex-1 h-px bg-gradient-to-l from-transparent to-gold/40" />
            </div>
            <p className="text-muted text-xs tracking-[0.18em] uppercase font-cinzel">
              AI-Powered Tattoo Design
            </p>
          </div>

          <div className="flex items-center gap-2 mt-2">
            <div className="w-4 h-4 border-2 border-gold/40 border-t-gold rounded-full animate-spin" />
            <span className="text-muted text-xs font-mono tracking-widest">Loading…</span>
          </div>
        </motion.div>

        <p className="absolute bottom-6 text-muted text-[10px] font-mono tracking-widest z-10">
          CLEOPATRA INK STUDIO © 2026
        </p>
      </main>
    );
  }

  if (!admin) {
    return <>{children}</>;
  }

  async function handleLogout() {
    // scope: "local" clears this device's session without a server round
    // trip — a dropped connection there must never leave the cookie intact.
    await supabase.auth.signOut({ scope: "local" });
    router.push("/studio/login");
    router.refresh();
  }

  // Bottom mobile-app-style tab bar is scoped to /studio/admin/* pages only
  // — the customer profile and session-flow pages an admin can also reach
  // (/customer/[userId], /[sessionId]/design|placement) already have their
  // own fixed sticky action bar at the bottom on phone widths, and a second
  // fixed bar there would overlap it.
  const isAdminSection = pathname.startsWith("/studio/admin");

  return (
    <div className="h-[100dvh] min-h-0 bg-bg flex flex-col lg:flex-row overflow-hidden">
      {/* Sidebar — only on genuinely wide (desktop) viewports. Narrower ones
          (phone through tablet/split-screen) get the compact top tab bar
          below instead — a fixed 224px rail left too little room for the
          dashboard's content at those widths. Fixed in place; only <main> scrolls. */}
      <aside className="hidden lg:flex lg:flex-col w-64 flex-shrink-0 min-h-0 border-r border-cleo-border bg-surface/40 px-4 py-6 gap-6 overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2">
          <div className="w-7 h-7 relative flex-shrink-0">
            <Image src="/cleopatra-logo.svg" alt="Cleopatra" fill className="object-contain" />
          </div>
          <div>
            <p className="font-cinzel text-[11px] font-bold tracking-[0.15em] text-gold uppercase leading-none">Cleopatra Ink</p>
            <p className="text-[10px] font-mono text-muted tracking-wider leading-none mt-0.5">Admin Portal</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {ALL_NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-cinzel font-bold tracking-wide transition-colors border ${
                  active
                    ? "bg-gold/10 text-gold border-gold/30"
                    : "text-muted hover:text-ink hover:bg-surface border-transparent"
                }`}
              >
                {item.icon}
                <span className="flex-1 whitespace-nowrap">{item.label}</span>
                {item.href === TRASH_HREF && <NavBadge count={trashCount} />}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3">
          <Link href="/studio/admin/settings" className="flex items-center gap-2.5 px-2 group">
            <div className="relative w-8 h-8 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center overflow-hidden flex-shrink-0">
              {admin.avatar_url ? (
                <Image src={admin.avatar_url} alt={admin.name} fill unoptimized className="object-cover" />
              ) : (
                <span className="font-cinzel text-xs font-black text-gold">{admin.name.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-ink text-xs font-semibold truncate group-hover:text-gold transition-colors">{admin.name}</p>
              <p className="text-muted text-[9px] font-mono uppercase tracking-wider">Admin</p>
            </div>
          </Link>
          <button
            onClick={handleLogout}
            className="text-muted hover:text-error transition-colors text-xs font-mono tracking-wider px-3 py-2 rounded-lg border border-cleo-border hover:border-error/40 cursor-pointer text-left"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Top tab bar — phone through tablet/split-screen widths */}
      <div className="lg:hidden border-b border-cleo-border bg-surface/40 flex-shrink-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 relative flex-shrink-0">
              <Image src="/cleopatra-logo.svg" alt="Cleopatra" fill className="object-contain" />
            </div>
            <p className="font-cinzel text-[11px] font-bold tracking-[0.15em] text-gold uppercase leading-none">Cleopatra Ink</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-muted hover:text-error transition-colors text-[10px] font-mono tracking-wider px-2.5 py-1.5 rounded-lg border border-cleo-border cursor-pointer"
          >
            Logout
          </button>
        </div>
        {/* On phone widths, admin-section pages use the bottom tab bar
            instead — this strip only shows there from tablet width up. */}
        <nav className={`${isAdminSection ? "hidden sm:flex" : "flex"} gap-1.5 px-3 pb-3 overflow-x-auto`}>
          {ALL_NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-cinzel font-bold uppercase tracking-wider transition-colors ${
                  active ? "bg-gold text-bg" : "text-muted border border-cleo-border"
                }`}
              >
                {item.icon}
                {item.label}
                {item.href === TRASH_HREF && <NavBadge count={trashCount} />}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Page content */}
      <main className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto ${isAdminSection ? "pb-20 sm:pb-0" : ""}`}>{children}</main>

      {/* Bottom tab bar — mobile-app style, phone widths, admin section only */}
      {isAdminSection && (
        <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur-md border-t border-cleo-border flex items-stretch pb-safe">
          {ALL_NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 transition-colors ${active ? "text-gold" : "text-muted"}`}
              >
                <span className="relative">
                  {cloneElement(item.icon, { className: "w-5 h-5" })}
                  {item.href === TRASH_HREF && trashCount > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[0.9rem] h-[0.9rem] px-0.5 rounded-full bg-gold text-bg text-[8px] font-mono font-bold flex items-center justify-center leading-none">
                      {trashCount > 99 ? "99+" : trashCount}
                    </span>
                  )}
                </span>
                <span className="text-[9px] font-cinzel font-bold uppercase tracking-wide">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
