"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { useAppStore } from "@/store/app-store";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";
import { resolveImageSrc } from "@/lib/image-src";
import { uploadPhotoDirect, uploadBase64Direct } from "@/lib/browser-upload";
import { startFlashGeneration } from "@/lib/flash-generation";

const supabase = createSupabaseBrowserClient();

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  image_urls: string[];
  design_ids: string[];
  created_at: string;
}

interface JobSlot {
  status: "pending" | "done" | "error";
  imageBase64?: string;
  reason?: string;
  code?: string;
}

// Local, per-message render state for one image slot in an in-flight batch.
// Every slot must always resolve to "done" (real image now in the message)
// or "error" (visible tile + retry) — never silently disappear.
interface PendingSlot {
  status: "loading" | "error" | "done";
  reason?: string;
}

interface LastRequest {
  isFirst: boolean;
  editSourceIds: string[];
  instructionForTurn: string;
  referenceUrls: string[];
  thisCount: number;
}

const COUNT_OPTIONS = [1, 2, 3, 4, 5] as const;
const POLL_INTERVAL_MS = 5000;
const MAX_NOT_FOUND_ATTEMPTS = 3; // ~15s grace before declaring a job lost
const MAX_STATUS_NETWORK_ERRORS = 6; // ~30s grace before declaring the connection lost

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ChatInner({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editTargetId = searchParams.get("edit");

  const {
    flowType, reworkMode, reworkPhoto,
    tattooStyle, tattooDescription, targetBodyArea, selectedColors, referenceImages,
    isTextTattoo, textTattooFont,
    pendingGeneration, setPendingGeneration,
    persistDesigns, selectDesign, finalizeReworkSession,
  } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [finalizedIds, setFinalizedIds] = useState<Set<string>>(new Set());
  const [finalizeToast, setFinalizeToast] = useState(false);
  // Authoritative session context — read from the DB, not just the in-memory
  // store, so reopening a session later (e.g. "Continue Design" from history)
  // still shows correct chips even if the store has a different session loaded.
  const [sessionFlowType, setSessionFlowType] = useState<"ai_design" | "rework" | "direct">(flowType);
  const [sessionReworkMode, setSessionReworkMode] = useState<"cover" | "extend">(reworkMode);
  const [sessionStyle, setSessionStyle] = useState(tattooStyle);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState("");
  const [count, setCount] = useState(2);
  const [isCountOpen, setIsCountOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingSlots, setPendingSlots] = useState<Record<string, PendingSlot[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [confirmingUse, setConfirmingUse] = useState<{ id: string; url: string } | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Plain reference photos (uploaded/selected source images) aren't tied to a
  // design id, so they get their own view-only lightbox instead of the
  // Select/Use-this one below, which only makes sense for generated results.
  const [viewingRawUrl, setViewingRawUrl] = useState<string | null>(null);

  const didKickoffRef = useRef(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const processedSlotsRef = useRef<Set<number>>(new Set());
  const countRef = useRef<HTMLDivElement>(null);
  // Keyed by assistant message id so a Retry always redoes the right request,
  // even if the user has since sent a newer message.
  const lastRequestByMessage = useRef<Record<string, LastRequest>>({});

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (countRef.current && !countRef.current.contains(e.target as Node)) setIsCountOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function findImageUrl(designId: string): string | undefined {
    for (const m of messages) {
      const idx = m.design_ids.indexOf(designId);
      if (idx !== -1) return m.image_urls[idx];
    }
    return undefined;
  }

  // Every design image across the whole chat thread, in the order they
  // appear — prev/next in the lightbox walks this full list, not just the
  // batch the currently-open image came from.
  function allDesignIds(): string[] {
    return messages.flatMap((m) => m.design_ids);
  }

  // Stops at the ends — no wraparound from last back to first.
  function viewAdjacent(direction: 1 | -1) {
    setViewingId((current) => {
      if (!current) return current;
      const all = allDesignIds();
      const idx = all.indexOf(current);
      const nextIdx = idx + direction;
      if (idx === -1 || nextIdx < 0 || nextIdx >= all.length) return current;
      return all[nextIdx];
    });
  }

  // Keyboard nav for the lightbox
  useEffect(() => {
    if (!viewingId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setViewingId(null);
      if (e.key === "ArrowRight") viewAdjacent(1);
      if (e.key === "ArrowLeft") viewAdjacent(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingId]);

  // ── Load session context + full chat transcript ──────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: session } = await supabase
        .from("sessions")
        .select("flow_type, rework_mode, tattoo_style")
        .eq("id", sessionId)
        .maybeSingle();

      // Upload Existing sessions have nothing for Chat to show — there was
      // never a generation to refine. This is a hard backstop independent
      // of how the redirect got skipped elsewhere (a stale flow_type from
      // before this guard existed, a future bug, a direct URL visit, etc.)
      // — Chat must never render for one of these, full stop.
      if (session?.flow_type === "direct") {
        if (!cancelled) router.replace(`/${sessionId}/placement`);
        return;
      }

      if (!cancelled && session) {
        setSessionFlowType((session.flow_type as "ai_design" | "rework" | "direct" | null) ?? flowType);
        setSessionReworkMode((session.rework_mode as "cover" | "extend" | null) ?? reworkMode);
        setSessionStyle(session.tattoo_style ?? tattooStyle);
      }

      const [chatRes, designsRes] = await Promise.all([
        supabase.from("chat_messages").select("id, role, content, image_urls, design_ids, created_at").eq("session_id", sessionId).order("created_at", { ascending: true }),
        supabase.from("tattoo_designs").select("id, is_finalized").eq("session_id", sessionId),
      ]);

      if (cancelled) return;

      const loadedMessages: ChatMessage[] = chatRes.data ?? [];
      setMessages(loadedMessages);
      setFinalizedIds(new Set((designsRes.data ?? []).filter((d) => d.is_finalized).map((d) => d.id)));
      setLoading(false);

      if (editTargetId) {
        setSelectedIds(new Set([editTargetId]));
      }

      // Fires on a fresh session (no history yet) and also when the designer
      // went back to Design/Rework, changed the reference photo/colors/style,
      // and hit Generate again — that's a new fresh batch, appended as a new
      // message here rather than replacing or ignoring the existing thread.
      if (pendingGeneration && !didKickoffRef.current) {
        didKickoffRef.current = true;
        setPendingGeneration(false);
        startGeneration(true, []);
        return;
      }

      // Resume watching a generation that was still running when this page
      // loaded (e.g. a reload mid-generation, or reopening from another tab).
      if (!didKickoffRef.current) {
        didKickoffRef.current = true;
        let status: { found: boolean; done?: boolean; iteration?: number; slots?: JobSlot[] } = { found: false };
        try {
          const res = await fetch(`/api/generation-status?sessionId=${sessionId}`);
          status = await res.json();
        } catch {
          // Couldn't reach our own status endpoint on load — not fatal, the
          // message just renders with whatever images it already has.
        }
        const lastMessage = loadedMessages[loadedMessages.length - 1];
        if (!cancelled && status.found && !status.done && lastMessage?.role === "assistant" && status.slots) {
          const alreadyDone = lastMessage.image_urls.length;
          processedSlotsRef.current = new Set(Array.from({ length: alreadyDone }, (_, i) => i));
          setPendingSlots((prev) => ({
            ...prev,
            [lastMessage.id]: status.slots!.map((s, i) =>
              i < alreadyDone ? { status: "done" } : s.status === "error"
                ? { status: "error", reason: s.reason ?? "This image failed to generate." }
                : { status: "loading" }
            ),
          }));
          setSending(true);
          watchJob(lastMessage.id, status.iteration!);
        }
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingSlots]);

  function setSlot(messageId: string, index: number, slot: PendingSlot) {
    setPendingSlots((prev) => {
      const arr = prev[messageId] ? [...prev[messageId]] : [];
      arr[index] = slot;
      return { ...prev, [messageId]: arr };
    });
  }

  function failAllLoading(messageId: string, reason: string) {
    setPendingSlots((prev) => {
      const arr = (prev[messageId] ?? []).map((s) => (s.status === "loading" ? { status: "error" as const, reason } : s));
      return { ...prev, [messageId]: arr };
    });
  }

  // ── Poll a running job, appending each completed image to the
  // assistant message as it lands. Every slot always ends in "done" (real
  // image) or "error" (visible tile + retry) — the loop never exits leaving
  // a slot stuck on "loading" with nothing shown for it. ─────────
  async function watchJob(assistantMessageId: string, iteration: number) {
    const prefix = sessionFlowType === "rework" ? "rework" : "designs";
    const imageUrls: string[] = messages.find((m) => m.id === assistantMessageId)?.image_urls.slice() ?? [];
    const designIds: string[] = messages.find((m) => m.id === assistantMessageId)?.design_ids.slice() ?? [];

    let notFoundStreak = 0;
    let networkErrorStreak = 0;

    while (true) {
      let status: { found: boolean; done: boolean; slots: JobSlot[] } | null = null;
      try {
        const res = await fetch(`/api/generation-status?sessionId=${sessionId}`);
        status = await res.json();
        networkErrorStreak = 0;
      } catch {
        networkErrorStreak++;
        if (networkErrorStreak >= MAX_STATUS_NETWORK_ERRORS) {
          failAllLoading(assistantMessageId, "Lost connection while checking generation status.");
          break;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!status) continue; // unreachable — narrows the type below

      if (!status.found) {
        // The job can briefly be unobservable right after being started; give
        // it a few polls before treating it as genuinely lost.
        notFoundStreak++;
        if (notFoundStreak >= MAX_NOT_FOUND_ATTEMPTS) {
          failAllLoading(assistantMessageId, "Generation failed unexpectedly on the server.");
          break;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      notFoundStreak = 0;

      for (let i = 0; i < status.slots.length; i++) {
        if (processedSlotsRef.current.has(i)) continue;
        const slot = status.slots[i];
        if (slot.status === "pending") continue;
        processedSlotsRef.current.add(i);

        if (slot.status === "error") {
          const reason = slot.code === "insufficient_credits"
            ? "AI generation credits are exhausted. Contact the admin to top up."
            : (slot.reason || "This image failed to generate.");
          setSlot(assistantMessageId, i, { status: "error", reason });
          continue;
        }
        if (!slot.imageBase64) {
          setSlot(assistantMessageId, i, { status: "error", reason: "This image failed to generate." });
          continue;
        }

        try {
          const imageUrl = await uploadBase64Direct(slot.imageBase64, sessionId, prefix);
          const [persisted] = await persistDesigns(
            [{ id: `kei-${iteration}-${i}`, imageUrl, gradient: "", patternType: "mandala", styleName: `Variation ${i + 1}` }],
            { iteration }
          );
          const designId = persisted.dbId ?? persisted.id;
          imageUrls.push(persisted.imageUrl!);
          designIds.push(designId);

          await supabase.from("chat_messages").update({ image_urls: imageUrls, design_ids: designIds }).eq("id", assistantMessageId);
          setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? { ...m, image_urls: [...imageUrls], design_ids: [...designIds] } : m)));
          setSlot(assistantMessageId, i, { status: "done" });
        } catch (err) {
          setSlot(assistantMessageId, i, { status: "error", reason: `Failed to save: ${(err as Error).message}` });
        }
      }

      if (status.done) break;
      await sleep(POLL_INTERVAL_MS);
    }

    setSending(false);
  }

  // ── Core: create the message pair, kick off the job, watch it. Shared by
  // a fresh send and a Retry (which reuses everything but the count). ──
  async function runGeneration(req: LastRequest) {
    const { isFirst, editSourceIds, instructionForTurn, referenceUrls, thisCount } = req;
    setSending(true);
    setError(null);
    processedSlotsRef.current = new Set();

    const editSourceUrls = editSourceIds.map(findImageUrl).filter((u): u is string => !!u);
    const iteration = messages.filter((m) => m.role === "assistant").length + 1;

    let assistantMsgId: string | null = null;
    try {
      const { data: userMsg, error: userMsgErr } = await supabase
        .from("chat_messages")
        .insert({ session_id: sessionId, role: "user", content: instructionForTurn, image_urls: referenceUrls })
        .select()
        .single();
      if (userMsgErr) throw new Error(`Couldn't save your message: ${userMsgErr.message}`);

      const { data: assistantMsg, error: assistantMsgErr } = await supabase
        .from("chat_messages")
        .insert({ session_id: sessionId, role: "assistant", content: null, image_urls: [], design_ids: [] })
        .select()
        .single();
      if (assistantMsgErr) throw new Error(`Couldn't start the reply: ${assistantMsgErr.message}`);

      const newAssistantMsgId: string = assistantMsg.id;
      assistantMsgId = newAssistantMsgId;
      lastRequestByMessage.current[newAssistantMsgId] = req;
      setMessages((prev) => [...prev, userMsg as ChatMessage, assistantMsg as ChatMessage]);
      setPendingSlots((prev) => ({ ...prev, [newAssistantMsgId]: Array.from({ length: thisCount }, () => ({ status: "loading" as const })) }));
      setSelectedIds(new Set());
      setInstruction("");

      let res: Response;
      if (sessionFlowType === "rework") {
        const body: Record<string, unknown> = {
          sessionId, iteration, mode: sessionReworkMode, count: thisCount,
          parentDesignIds: isFirst ? [] : editSourceIds,
        };
        if (isFirst) {
          body.description = instructionForTurn;
          body.sourcePhotoUrl = referenceUrls[0];
        } else {
          body.editInstruction = instructionForTurn;
          body.editSourceUrls = editSourceUrls;
        }
        res = await fetch("/api/generate-rework", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      } else {
        const body: Record<string, unknown> = {
          sessionId, iteration, description: instructionForTurn, style: sessionStyle,
          images: [], referenceImageUrls: isFirst ? referenceUrls : [],
          isTextTattoo, colors: selectedColors, targetBodyArea, count: thisCount,
          parentDesignIds: isFirst ? [] : editSourceIds,
          ...(isTextTattoo && textTattooFont ? { textTattooFont } : {}),
        };
        if (!isFirst) {
          body.refineImageUrls = editSourceUrls;
          body.refinementText = instructionForTurn;
          body.selectedDesignNames = editSourceIds.map((_, i) => `Design ${i + 1}`);
        }
        res = await fetch("/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Generation failed to start");
      }

      await watchJob(newAssistantMsgId, iteration);
    } catch (err) {
      // The request never got a job running — every slot for this message
      // is unrecoverable without a retry, so mark them all as errored
      // instead of leaving them (or an empty gap) stuck on "loading".
      setError((err as Error).message);
      if (assistantMsgId) failAllLoading(assistantMsgId, (err as Error).message);
      setSending(false);
    }
  }

  // ── Start a new generation / edit ────────────────────────────
  async function startGeneration(isFirst: boolean, editSourceIds: string[]) {
    setSending(true);
    setError(null);
    const thisCount = isFirst ? 5 : count;
    const instructionForTurn = isFirst ? tattooDescription : instruction.trim();
    const editSourceUrls = editSourceIds.map(findImageUrl).filter((u): u is string => !!u);

    try {
      // Resolve the reference image(s) to durable URLs *before* recording the
      // user message, so the message always stores something that survives.
      let referenceUrls: string[];
      if (isFirst) {
        if (sessionFlowType === "rework") {
          referenceUrls = reworkPhoto ? [await uploadPhotoDirect(reworkPhoto, sessionId, "rework-source")] : [];
        } else {
          const localRefs = referenceImages.filter((r) => r.startsWith("blob:") || r.startsWith("data:"));
          const hostedRefs = referenceImages.filter((r) => !r.startsWith("blob:") && !r.startsWith("data:"));
          const uploadedRefs = await Promise.all(localRefs.map((r) => uploadPhotoDirect(r, sessionId, "refs")));
          referenceUrls = [...uploadedRefs, ...hostedRefs];
        }
      } else {
        referenceUrls = editSourceUrls;
      }

      await runGeneration({ isFirst, editSourceIds, instructionForTurn, referenceUrls, thisCount });
    } catch (err) {
      // Failed before a message even existed to attach an error tile to
      // (e.g. the reference photo itself failed to upload) — the banner is
      // the only place this can show.
      setError((err as Error).message);
      setSending(false);
    }
  }

  // ── Retry: redo the exact same request that produced this message,
  // reusing its already-uploaded reference photo(s) so nothing re-uploads.
  function retryGeneration(assistantMessageId: string) {
    const req = lastRequestByMessage.current[assistantMessageId];
    if (!req) {
      setError("Can't retry this automatically — please send a new message instead.");
      return;
    }
    runGeneration(req);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSend() {
    if (sending) return;
    if (selectedIds.size === 0) { setError("Select at least one image to edit — the instruction alone isn't enough, pick what it applies to."); return; }
    if (!instruction.trim()) return;
    startGeneration(false, [...selectedIds]);
  }

  async function handleFinalize(designId: string, imageUrl: string) {
    setFinalizing(designId);
    try {
      await finalizeReworkSession(designId);
      // Only one design can be finalized at a time — replace, not add, so
      // the gold badge moves instead of stacking on multiple tiles.
      setFinalizedIds(new Set([designId]));
      setFinalizeToast(true);
      setTimeout(() => setFinalizeToast(false), 2500);
      // Kick off the flash/sticker isolate in the background — chat doesn't
      // wait for or show it, Session Details is where it surfaces.
      startFlashGeneration(designId, imageUrl).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFinalizing(null);
    }
  }

  // Finalize is a one-way, visible action (locks in the design, and for
  // Rework replaces whatever was finalized before) — confirm before doing it.
  function requestUse(designId: string, imageUrl: string) {
    setConfirmingUse({ id: designId, url: imageUrl });
  }

  function handleUse(designId: string, imageUrl: string) {
    if (sessionFlowType === "rework") {
      handleFinalize(designId, imageUrl);
    } else {
      selectDesign({ id: designId, dbId: designId, gradient: "", patternType: "mandala", styleName: "Design", imageUrl });
      router.push(`/${sessionId}/placement`);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const viewingUrl = viewingId ? findImageUrl(viewingId) : undefined;
  const viewingSiblings = viewingId ? allDesignIds() : [];
  const viewingSiblingIndex = viewingId ? viewingSiblings.indexOf(viewingId) : -1;

  return (
    <div className="relative flex flex-col h-[calc(100vh-57px)]">
      {/* Finalize confirmation — non-blocking, stays in chat so the studio
          can keep editing or finalize a different design right after */}
      {finalizeToast && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-surface border border-gold/40 rounded-full px-4 py-2 shadow-2xl flex items-center gap-2"
        >
          <svg className="w-4 h-4 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          <span className="text-ink text-xs font-cinzel font-bold tracking-wide">Design finalized</span>
        </motion.div>
      )}

      {/* Thread — capped and centered to match the composer below it, instead
          of stretching edge-to-edge on wide screens */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pt-5 pb-28 sm:pb-32 flex flex-col gap-4 items-center">
        <div className="w-full sm:max-w-2xl flex flex-col gap-4">
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center py-20">
            <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center">
              <span className="text-xl text-gold/60">✦</span>
            </div>
            <div>
              <p className="text-ink font-cinzel font-bold text-sm">No messages yet</p>
              <p className="text-muted text-xs mt-1 max-w-xs">Your generated designs will show up here once they&apos;re ready.</p>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          msg.role === "user" ? (
            <div key={msg.id} className="flex justify-end">
              <div className="max-w-[85%] sm:max-w-md bg-gold/10 border border-gold/30 rounded-2xl rounded-tr-sm px-4 py-2.5 flex flex-col gap-2">
                {msg.image_urls.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {msg.image_urls.map((url, i) => (
                      <div
                        key={i}
                        onClick={() => setViewingRawUrl(url)}
                        className="w-14 h-14 rounded-lg overflow-hidden border border-gold/30 flex-shrink-0 cursor-pointer hover:border-gold transition-colors"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={resolveImageSrc(url)} alt="Reference" className="w-full h-full object-cover" />
                      </div>
                    ))}
                  </div>
                )}
                {msg.content && <p className="text-ink text-sm leading-relaxed">{msg.content}</p>}
              </div>
            </div>
          ) : (
            <div key={msg.id} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5 sm:gap-3 max-w-3xl">
              {msg.design_ids.map((designId, i) => {
                const url = msg.image_urls[i];
                const isSelected = selectedIds.has(designId);
                const isFinalized = finalizedIds.has(designId);
                return (
                  <div
                    key={designId}
                    onClick={() => setViewingId(designId)}
                    className="relative group rounded-xl overflow-hidden border border-cleo-border bg-surface-2 cursor-pointer"
                    style={{ aspectRatio: "1" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={resolveImageSrc(url)} alt="Design" className="w-full h-full object-cover" />

                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSelect(designId); }}
                      className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-md border flex items-center justify-center transition-colors cursor-pointer ${
                        isSelected ? "bg-gold border-gold" : "bg-black/50 border-white/40 hover:border-gold"
                      }`}
                      title="Select for editing"
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>

                    {isFinalized && (
                      <div className="absolute top-1.5 left-1.5 right-1.5 flex justify-center">
                        <span className="text-[9px] font-mono uppercase tracking-wider bg-gold text-bg px-2 py-0.5 rounded-full">Finalized</span>
                      </div>
                    )}

                    <button
                      onClick={(e) => { e.stopPropagation(); requestUse(designId, url); }}
                      disabled={finalizing === designId}
                      className="absolute bottom-0 left-0 right-0 bg-black/70 backdrop-blur-sm text-white text-[10px] font-mono uppercase tracking-wider py-1.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-gold hover:text-bg disabled:opacity-50"
                    >
                      {finalizing === designId ? "Finalizing…" : "✦ Finalize"}
                    </button>
                  </div>
                );
              })}

              {/* In-flight slots: loading spinner, or an error tile with its own retry */}
              {(pendingSlots[msg.id] ?? []).map((slot, i) => {
                if (slot.status === "done") return null;
                if (slot.status === "error") {
                  return (
                    <div key={`slot-${i}`} className="rounded-xl overflow-hidden border border-error/40 bg-error/5 flex flex-col items-center justify-center gap-2 p-2 text-center" style={{ aspectRatio: "1" }}>
                      <svg className="w-5 h-5 text-error/80 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                      <p className="text-error text-[10px] leading-snug line-clamp-3">{slot.reason ?? "Failed to generate."}</p>
                      {!sending && (
                        <button
                          onClick={() => retryGeneration(msg.id)}
                          className="text-[10px] font-mono uppercase tracking-wider text-gold hover:text-gold-light underline underline-offset-2 cursor-pointer"
                        >
                          ⟳ Retry
                        </button>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={`slot-${i}`} className="rounded-xl overflow-hidden border border-cleo-border" style={{ aspectRatio: "1" }}>
                    <div className="w-full h-full skeleton flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-gold/50 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ))}

        {error && (
          <div className="bg-error/10 border border-error/30 rounded-xl px-4 py-3">
            <p className="text-error text-xs font-mono leading-relaxed">{error}</p>
          </div>
        )}

        <div ref={threadEndRef} />
        </div>
      </div>

      {/* Composer — floating above the thread, not docked to the edge */}
      <div className="absolute bottom-4 left-3 right-3 sm:left-6 sm:right-6 sm:max-w-2xl sm:mx-auto">
        <div className="bg-surface border border-cleo-border rounded-2xl shadow-2xl px-3.5 py-3 flex flex-col gap-2.5">
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {[...selectedIds].map((id) => {
                const url = findImageUrl(id);
                if (!url) return null;
                return (
                  <div
                    key={id}
                    onClick={() => setViewingRawUrl(url)}
                    className="relative w-11 h-11 rounded-lg overflow-hidden border border-gold/40 flex-shrink-0 cursor-pointer"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={resolveImageSrc(url)} alt="Selected reference" className="w-full h-full object-cover" />
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSelect(id); }}
                      className="absolute top-0 right-0 w-4 h-4 bg-black/70 hover:bg-error text-white text-[9px] flex items-center justify-center rounded-bl-md cursor-pointer transition-colors"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-11 flex items-center bg-bg border border-cleo-border rounded-xl px-3.5 focus-within:border-gold transition-colors">
              <textarea
                rows={1}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={selectedIds.size === 0 ? "Select an image above, then describe your change…" : "e.g. Make the mane fuller, remove the small stars…"}
                className="focus-ring-none w-full bg-transparent text-ink text-sm placeholder:text-muted/50 focus:outline-none resize-none leading-normal py-0"
              />
            </div>

            {/* Image-count dropdown */}
            <div ref={countRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setIsCountOpen((v) => !v)}
                className="h-11 px-3 rounded-xl bg-bg border border-cleo-border hover:border-gold/50 text-ink flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Number of images to generate"
              >
                <svg className="w-4 h-4 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <rect x="3" y="5" width="14" height="14" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 9a1 1 0 100-2 1 1 0 000 2zm0 8l3.5-4.5 2.5 3L16 11l4 6" />
                </svg>
                <span className="text-sm font-mono font-bold">{count}</span>
                <svg className={`w-3 h-3 text-muted transition-transform ${isCountOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {isCountOpen && (
                <div className="absolute bottom-full mb-2 right-0 bg-surface-2 border border-cleo-border rounded-xl shadow-2xl overflow-hidden z-10 min-w-[7rem]">
                  <p className="px-3 pt-2.5 pb-1.5 text-[9px] font-mono uppercase tracking-widest text-muted/60 border-b border-cleo-border">Images to Generate</p>
                  {COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      onClick={() => { setCount(n); setIsCountOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-sm font-mono transition-colors cursor-pointer hover:bg-gold/10 ${
                        count === n ? "text-gold font-bold bg-gold/5" : "text-ink"
                      }`}
                    >
                      {n} image{n === 1 ? "" : "s"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleSend}
              disabled={sending || !instruction.trim() || selectedIds.size === 0}
              className="flex-shrink-0 w-11 h-11 rounded-xl bg-gold text-bg flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-gold-light transition-colors"
            >
              {sending ? (
                <div className="w-4 h-4 border-2 border-bg/40 border-t-bg rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Full-screen viewer */}
      {viewingId && viewingUrl && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={() => setViewingId(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
        >
          <button
            onClick={() => setViewingId(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors flex items-center justify-center text-xl cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>

          {viewingSiblingIndex > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); viewAdjacent(-1); }}
              className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors flex items-center justify-center cursor-pointer"
              aria-label="Previous image"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {viewingSiblingIndex !== -1 && viewingSiblingIndex < viewingSiblings.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); viewAdjacent(1); }}
              className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors flex items-center justify-center cursor-pointer"
              aria-label="Next image"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-4 max-w-2xl w-full">
            <div className="relative w-full rounded-2xl overflow-hidden border border-cleo-border" style={{ aspectRatio: "1" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveImageSrc(viewingUrl)} alt="Design" className="w-full h-full object-contain bg-black" />
            </div>
            <div className="flex items-center gap-3 w-full max-w-sm">
              <button
                onClick={() => { toggleSelect(viewingId); setViewingId(null); }}
                className={`flex-1 py-3 rounded-xl font-cinzel font-bold text-xs tracking-[0.08em] uppercase border transition-colors cursor-pointer ${
                  selectedIds.has(viewingId)
                    ? "bg-gold text-bg border-gold"
                    : "bg-transparent text-white border-white/30 hover:border-gold"
                }`}
              >
                {selectedIds.has(viewingId) ? "✓ Selected" : "Select to Edit"}
              </button>
              <button
                onClick={() => { const id = viewingId; const url = viewingUrl; setViewingId(null); requestUse(id, url); }}
                disabled={finalizing === viewingId}
                className="flex-1 py-3 rounded-xl bg-gold text-bg font-cinzel font-bold text-xs tracking-[0.08em] uppercase border border-gold hover:bg-gold-light transition-colors cursor-pointer disabled:opacity-50"
              >
                {finalizing === viewingId ? "Finalizing…" : "✦ Finalize"}
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Full-screen viewer for reference photos (view only — no design to select/use) */}
      {viewingRawUrl && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={() => setViewingRawUrl(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
        >
          <button
            onClick={() => setViewingRawUrl(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors flex items-center justify-center text-xl cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
          <div onClick={(e) => e.stopPropagation()} className="max-w-2xl w-full">
            <div className="relative w-full rounded-2xl overflow-hidden border border-cleo-border" style={{ aspectRatio: "1" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveImageSrc(viewingRawUrl)} alt="Reference" className="w-full h-full object-contain bg-black" />
            </div>
          </div>
        </motion.div>
      )}

      {/* Finalize confirmation */}
      {confirmingUse && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={() => setConfirmingUse(null)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-surface border border-cleo-border rounded-2xl p-5 max-w-sm w-full flex flex-col gap-4"
          >
            <div className="w-full aspect-square rounded-xl overflow-hidden border border-cleo-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveImageSrc(confirmingUse.url)} alt="Design to finalize" className="w-full h-full object-cover" />
            </div>
            <div>
              <h2 className="font-cinzel text-base font-bold text-ink">Finalize this design?</h2>
              <p className="text-muted text-xs mt-1 leading-relaxed">
                {sessionFlowType === "rework"
                  ? "This becomes the finalized design for this customer, replacing whatever was finalized before. You can still keep editing and finalize a different one later."
                  : "You'll continue to Placement with this design."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setConfirmingUse(null)}
                className="flex-1 py-3 rounded-xl font-cinzel font-bold text-xs tracking-[0.08em] uppercase border border-cleo-border text-muted hover:text-ink transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { const { id, url } = confirmingUse; setConfirmingUse(null); handleUse(id, url); }}
                className="flex-1 py-3 rounded-xl bg-gold text-bg font-cinzel font-bold text-xs tracking-[0.08em] uppercase border border-gold hover:bg-gold-light transition-colors cursor-pointer"
              >
                ✦ Finalize
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}

export default function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  return (
    <Suspense fallback={<div className="min-h-[60vh] flex items-center justify-center"><div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" /></div>}>
      <ChatInner sessionId={sessionId} />
    </Suspense>
  );
}
