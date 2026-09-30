"use client";

import { use, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";
import { resolveBackUrl } from "@/lib/auth-utils";

const supabase = createSupabaseBrowserClient();

const AI_DESIGN_STEPS = [
  { label: "Design", path: "design" },
  { label: "Placement", path: "placement" },
];
const REWORK_STEPS = [{ label: "Rework", path: "design" }];

export default function SessionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const customerName = useAppStore((s) => s.customerName);
  const flowType = useAppStore((s) => s.flowType);

  const STEPS = flowType === "rework" ? REWORK_STEPS : AI_DESIGN_STEPS;
  // /chat is a sub-screen of Design/Rework, not its own step
  const matchPath = pathname.includes("chat") ? "design" : pathname;
  const currentStep = STEPS.findIndex((s) => matchPath.includes(s.path));
  const isPlacement = pathname.includes("placement");
  const isChat = pathname.includes("chat");

  // Design is step 1, reachable from several different lists (a customer's
  // page, a dashboard, a session overview) — resolved the same role-checked
  // way those pages resolve their own back button, from a ?from= param
  // those lists append when they send someone here. Chat and Placement,
  // unlike Design, always have one deterministic previous step within this
  // same flow, so they never need it.
  const [designBackUrl, setDesignBackUrl] = useState("/studio/designer");
  const [designBackLabel, setDesignBackLabel] = useState("Dashboard");

  useEffect(() => {
    if (isPlacement || isChat) return; // only Design's back needs this
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: staffRow } = await supabase.from("staff").select("role").eq("id", user.id).maybeSingle();
      const role = (staffRow?.role as "admin" | "designer" | undefined) ?? null;
      const defaultUrl = role === "admin" ? "/studio/admin" : "/studio/designer";
      const defaultLabel = role === "admin" ? "Admin" : "Dashboard";
      const resolved = resolveBackUrl(searchParams.get("from"), role, defaultUrl, defaultLabel);
      if (!cancelled) {
        setDesignBackUrl(resolved.backUrl);
        setDesignBackLabel(resolved.backLabel);
      }
    })();
    return () => { cancelled = true; };
  }, [isPlacement, isChat, searchParams]);

  function handleBack() {
    if (isPlacement) {
      // AI Design reaches Placement from Chat (a design is picked there);
      // Upload Existing reaches it directly from Design (no chat at all);
      // Rework never has a placement step, so it never hits this branch.
      router.push(flowType === "direct" ? `/${sessionId}/design` : `/${sessionId}/chat`);
    } else if (isChat) {
      // Chat is always a sub-screen of Design — one deterministic step back,
      // regardless of how this session's Chat screen was originally reached.
      router.push(`/${sessionId}/design`);
    } else {
      // Design (step 1) — leaving the flow entirely, back to wherever sent us.
      router.push(designBackUrl);
    }
  }

  const backLabel = !isPlacement && !isChat ? designBackLabel : "Back";

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <header className="sticky top-0 z-30 bg-surface border-b border-cleo-border px-4 sm:px-6 py-3 flex items-center gap-4">
        {/* Back */}
        <button
          type="button"
          onClick={handleBack}
          className="text-muted hover:text-gold transition-colors flex items-center gap-1 flex-shrink-0 cursor-pointer"
          aria-label="Go back"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span className="hidden sm:block text-xs font-mono tracking-wider">{backLabel}</span>
        </button>

        <div className="w-px h-5 bg-cleo-border flex-shrink-0" />

        {/* Customer info */}
        {customerName && (
          <div className="flex items-center gap-2 bg-surface-2 border border-cleo-border rounded-lg px-3 py-1.5">
            <div className="w-5 h-5 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center">
              <span className="text-gold text-[9px] font-bold font-cinzel">
                {customerName.charAt(0).toUpperCase()}
              </span>
            </div>
            <span className="text-ink text-xs font-cinzel font-bold">{customerName}</span>
          </div>
        )}

        {/* Step progress */}
        <div className="ml-auto flex items-center gap-2">
          {STEPS.map((step, i) => {
            const isDone = i < currentStep;
            const isActive = i === currentStep;
            return (
              <div key={step.label} className="flex items-center gap-2">
                {i > 0 && (
                  <div className={`h-px w-6 sm:w-10 transition-colors ${isDone || isActive ? "bg-gold/50" : "bg-cleo-border"}`} />
                )}
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full transition-all ${isActive ? "bg-gold scale-125" : isDone ? "bg-gold/50" : "bg-cleo-border"}`} />
                  <span className={`hidden sm:block text-[10px] font-cinzel uppercase tracking-wider transition-colors ${isActive ? "text-gold" : isDone ? "text-gold/50" : "text-muted"}`}>
                    {step.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
