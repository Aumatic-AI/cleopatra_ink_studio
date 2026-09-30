"use client";

import { use, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useDropzone } from "react-dropzone";
import { useAppStore } from "@/store/app-store";
import type { PlacementResult } from "@/store/app-store";
import CameraCapture from "@/components/camera/CameraCapture";
import TattooPlacementEditor from "@/components/placement/TattooPlacementEditor";
import { uploadPhotoDirect, uploadBase64Direct } from "@/lib/browser-upload";
import { resolveImageSrc } from "@/lib/image-src";
import { getModelLabel } from "@/lib/model-labels";

// Shown when the AI image service rejects the request for exhausted credits.
// Direct copy so studio staff immediately know the fix is to top up the AI
// credits, not to debug something else.
const SERVICE_UNAVAILABLE_MSG =
  "AI generation credits are exhausted. Please contact the admin to top up the credits and restore the service.";

const QUICK_PLACEMENTS = [
  "Upper arm / bicep",
  "Forearm",
  "Wrist",
  "Shoulder / deltoid",
  "Upper back",
  "Chest",
  "Neck",
  "Ankle / foot",
  "Calf",
  "Rib cage",
  "Thigh",
  "Behind the ear",
];

const PLACEMENT_POLL_INTERVAL_MS = 4000;
const MAX_NOT_FOUND_ATTEMPTS = 3; // grace period for a job that was *just* started

type PlacementSlotOutcome =
  | { model?: string; imageBase64: string }
  | { model?: string; error: string; code?: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the fire-and-forget placement job to completion instead of holding
// one HTTP request open for the 1-3 minutes generation can take — that also
// means a page reload doesn't lose an in-progress preview, since the job
// lives on the server, not in this component. One slot per model (see
// AGENTS.md) — waits for every slot to resolve, then returns them all.
async function watchPlacementJob(sessionId: string): Promise<PlacementSlotOutcome[]> {
  const jobKey = `placement:${sessionId}`;
  let notFoundStreak = 0;

  while (true) {
    let status: { found: boolean; done?: boolean; slots?: Array<{ status: string; imageBase64?: string; reason?: string; code?: string; model?: string }> };
    try {
      const res = await fetch(`/api/generation-status?sessionId=${encodeURIComponent(jobKey)}`);
      status = await res.json();
    } catch {
      await sleep(PLACEMENT_POLL_INTERVAL_MS);
      continue;
    }

    if (!status.found) {
      notFoundStreak++;
      if (notFoundStreak >= MAX_NOT_FOUND_ATTEMPTS) {
        return [{ error: "Generation failed unexpectedly on the server." }];
      }
      await sleep(PLACEMENT_POLL_INTERVAL_MS);
      continue;
    }
    notFoundStreak = 0;

    if (!status.done || !status.slots || status.slots.length === 0) {
      await sleep(PLACEMENT_POLL_INTERVAL_MS);
      continue;
    }

    return status.slots.map((slot) => {
      if (slot.status === "error") return { model: slot.model, error: slot.reason ?? "Placement generation failed", code: slot.code };
      if (!slot.imageBase64) return { model: slot.model, error: "This image failed to generate." };
      return { model: slot.model, imageBase64: slot.imageBase64 };
    });
  }
}

// Shared by the fresh-generate path and the resume-on-reload path: uploads
// each successful slot and persists it as its own placements row, all
// sharing one attemptId so they group together as one comparison on reload.
async function persistPlacementOutcomes(
  outcomes: PlacementSlotOutcome[],
  sessionId: string,
  persistPlacement: (data: { placementText?: string; bodyPhotoUrl?: string; compositeUrl?: string; model?: string; attemptId?: string }) => Promise<string | null>,
  extra?: { placementText?: string; bodyPhotoUrl?: string }
): Promise<{ results: PlacementResult[]; firstError: { message: string; code?: string } | null }> {
  const attemptId = crypto.randomUUID();
  const results: PlacementResult[] = [];
  let firstError: { message: string; code?: string } | null = null;

  for (const outcome of outcomes) {
    if ("error" in outcome) {
      if (!firstError) firstError = { message: outcome.error, code: outcome.code };
      continue;
    }
    try {
      const resultUrl = await uploadBase64Direct(outcome.imageBase64, sessionId, "previews");
      const id = await persistPlacement({ ...extra, compositeUrl: resultUrl, model: outcome.model, attemptId });
      if (id) results.push({ dbId: id, url: resultUrl, model: outcome.model ?? null });
    } catch (err) {
      if (!firstError) firstError = { message: (err as Error).message };
    }
  }
  return { results, firstError };
}

export default function PlacementPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const router = useRouter();

  const {
    selectedDesign,
    customerName,
    customerId,
    placementText,
    setPlacementText,
    bodyPhoto,
    setBodyPhoto,
    placementResults,
    generatePlacement,
    finishPlacement,
    isGeneratingPlacement,
    persistPlacement,
    finalizeSession,
    hydrateFromSession,
    sessionStatus,
  } = useAppStore();

  const [hydrating, setHydrating] = useState(false);

  const [inputMode, setInputMode] = useState<"text" | "upload" | "camera">("text");
  const [showCamera, setShowCamera] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True when the failure was an exhausted-credits stop — suppresses the
  // "transient, tap retry" framing and the Retry button.
  const [creditsError, setCreditsError] = useState(false);
  // Composite from the interactive placement editor (base64 data URL)
  const [placementComposite, setPlacementComposite] = useState<string | null>(null);
  // dbId of whichever result tile is currently being finalized
  const [finalizingDbId, setFinalizingDbId] = useState<string | null>(null);
  // Seconds elapsed since the current generation started; drives the loading UI.
  const [elapsed, setElapsed] = useState(0);
  const loadingRef = useRef<HTMLDivElement>(null);

  // Tick the elapsed counter while a generation is in flight.
  useEffect(() => {
    if (!isGeneratingPlacement) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isGeneratingPlacement]);

  // Bring the loading panel into view as soon as generation starts — it sits
  // below the fold on most screens, so without this the button just looks
  // stuck with no visible feedback until the user scrolls manually.
  useEffect(() => {
    if (isGeneratingPlacement) {
      setTimeout(() => loadingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  }, [isGeneratingPlacement]);

  // KEI typically takes 90-180s for the composite step. Cycle status text so
  // the user knows the wait is normal and not a hang.
  const STAGE_MESSAGES = [
    "Analyzing your placement…",
    "Mapping the design to skin contours…",
    "Matching lighting and shadows…",
    "Adding realistic ink absorption…",
    "Finalizing the preview…",
  ];
  const stageIdx = Math.min(STAGE_MESSAGES.length - 1, Math.floor(elapsed / 35));
  const expectedSeconds = 180;
  const progressPct = Math.min(95, (elapsed / expectedSeconds) * 100);

  // Restore state from Supabase on mount so a reload doesn't kick the user back.
  // Page renders immediately from localStorage. Hydration runs in background;
  // redirect only fires after it confirms the required data is genuinely absent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await hydrateFromSession(sessionId);
      if (!cancelled) setHydrating(true);

      // Resume a placement generation that was still running when this page
      // reloaded — the job lives on the server, not in this component, so a
      // reload no longer loses it.
      let status: { found: boolean; done?: boolean } = { found: false };
      try {
        const res = await fetch(`/api/generation-status?sessionId=${encodeURIComponent(`placement:${sessionId}`)}`);
        status = await res.json();
      } catch {
        // Best-effort — not fatal if we can't check.
      }
      if (!cancelled && status.found && !status.done) {
        generatePlacement();
        const outcomes = await watchPlacementJob(sessionId);
        if (cancelled) return;
        const { results, firstError } = await persistPlacementOutcomes(outcomes, sessionId, persistPlacement);
        finishPlacement(results);
        if (results.length === 0) {
          if (firstError?.code === "insufficient_credits") setCreditsError(true);
          setError(firstError?.message ?? "Placement generation failed");
        } else if (firstError) {
          setError(`One version failed to generate: ${firstError.message}`);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hydrateFromSession]);

  useEffect(() => {
    if (!hydrating) return;
    if (!customerName) router.replace("/");
    else if (!selectedDesign) router.replace(`/${sessionId}/design`);
  }, [hydrating, customerName, selectedDesign, sessionId, router]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".heic"] },
    maxFiles: 1,
    onDrop: (files) => {
      const f = files[0];
      if (f) {
        setBodyPhoto(URL.createObjectURL(f));
        setPlacementComposite(null);
      }
    },
  });

  const isPhotoMode = inputMode === "upload" || inputMode === "camera";
  // In photo modes, user must go through the placement editor first
  const canGenerate =
    (inputMode === "text" && placementText.trim().length > 0) ||
    (isPhotoMode && !!placementComposite);

  async function handleGenerate() {
    if (!canGenerate || !selectedDesign) return;
    setError(null);
    setCreditsError(false);
    generatePlacement();

    try {
      const tattooImageUrl = selectedDesign.imageUrl;
      if (!tattooImageUrl) throw new Error("No tattoo image available — please go back and regenerate.");

      // Uploading TO Supabase from the server is unreliable on this machine —
      // upload straight from the browser and send the server only hosted
      // URLs, same fix already applied everywhere else in the app.
      let bodyPhotoUrl: string | undefined;
      let compositeUrl: string | undefined;

      if (isPhotoMode && placementComposite) {
        // Send the composite (positioned overlay) for exact placement reference
        compositeUrl = await uploadBase64Direct(placementComposite, sessionId, "composites");
        // Also send the body photo so the AI has 3 images: composite + design + skin
        if (bodyPhoto) {
          bodyPhotoUrl = await uploadPhotoDirect(bodyPhoto, sessionId, "body");
        }
      } else if (isPhotoMode && bodyPhoto) {
        bodyPhotoUrl = await uploadPhotoDirect(bodyPhoto, sessionId, "body");
      }

      const res = await fetch("/api/placement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          tattooImageUrl,
          bodyPhotoUrl,
          compositeUrl,
          placementText: inputMode === "text" ? placementText : "",
        }),
      });

      const startJson = await res.json();
      if (!res.ok) throw new Error(startJson.error ?? "Placement generation failed to start");

      const outcomes = await watchPlacementJob(sessionId);
      const { results, firstError } = await persistPlacementOutcomes(outcomes, sessionId, persistPlacement, {
        placementText: inputMode === "text" ? placementText : undefined,
        bodyPhotoUrl: bodyPhotoUrl ?? compositeUrl,
      });
      finishPlacement(results);

      if (results.length === 0) {
        if (firstError?.code === "insufficient_credits") {
          setCreditsError(true);
          setError(SERVICE_UNAVAILABLE_MSG);
        } else {
          setError(firstError?.message ?? "Placement generation failed");
        }
        return;
      }
      // Partial success (one model failed, the other worked) — show what we
      // have but still surface the failure so staff knows one model dropped.
      if (firstError) {
        setError(`One version failed to generate: ${firstError.message}`);
      }
    } catch (err) {
      setError((err as Error).message);
      finishPlacement([]);
    }
  }

  async function handleFinalize(dbId: string) {
    if (!selectedDesign?.dbId) {
      setError("Unable to finalize — please regenerate and try again.");
      return;
    }
    setFinalizingDbId(dbId);
    try {
      await finalizeSession(selectedDesign.dbId, dbId);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFinalizingDbId(null);
    }
  }

  function handleReset() {
    finishPlacement([]);
    setPlacementComposite(null);
    setError(null);
  }

  function handleModeChange(mode: "text" | "upload" | "camera") {
    setInputMode(mode);
    setBodyPhoto(null);
    setPlacementComposite(null);
    setPlacementText("");
  }

  /* ── Done / summary screen ──────────────────────────────────────── */
  if (done) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="flex flex-col items-center gap-8 text-center max-w-sm"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 180 }}
            className="relative"
          >
            <div className="w-24 h-24 rounded-full bg-gold shadow-[0_0_40px_rgba(201,168,76,0.6)] flex items-center justify-center">
              <svg className="w-12 h-12 text-bg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="absolute inset-0 rounded-full border-2 border-gold/30 animate-ping" />
          </motion.div>

          <div>
            <h1 className="font-cinzel text-3xl font-black text-ink">Session Complete!</h1>
            <p className="text-muted text-sm mt-3 leading-relaxed">
              {customerName}&apos;s design has been finalized and sent to the artist.
            </p>
          </div>

          <div className="bg-surface border border-cleo-border rounded-2xl p-5 w-full text-left flex flex-col gap-3">
            <p className="text-muted text-[10px] font-mono uppercase tracking-widest">Summary</p>
            <div className="flex items-center gap-3">
              <div
                className="w-14 h-14 rounded-xl overflow-hidden flex-shrink-0 border border-gold/30 relative"
                style={{ background: selectedDesign?.gradient }}
              >
                {selectedDesign?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveImageSrc(selectedDesign.imageUrl)}
                    alt={selectedDesign.styleName ?? "Design"}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : null}
              </div>
              <div>
                <p className="text-ink text-sm font-cinzel font-bold">{selectedDesign?.styleName}</p>
                <p className="text-muted text-xs">Placement: {placementText || "Body photo provided"}</p>
              </div>
            </div>
            <div className="h-px bg-cleo-border" />
            <div className="flex justify-between">
              <span className="text-muted text-xs font-mono">Customer</span>
              <span className="text-ink text-xs font-cinzel font-bold">{customerName}</span>
            </div>
          </div>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => router.push(customerId ? `/customer/${customerId}` : "/")}
            className="w-full bg-gold text-bg font-cinzel font-bold text-base tracking-[0.08em] uppercase py-4 rounded-xl border border-gold hover:bg-gold-light transition-colors cursor-pointer"
          >
            ✦ Back to Dashboard
          </motion.button>
        </motion.div>
      </div>
    );
  }

  /* ── Main placement screen ──────────────────────────────────────── */
  return (
    <>
      <AnimatePresence>
        {showCamera && (
          <CameraCapture
            onCapture={(url) => { setBodyPhoto(url); setShowCamera(false); setPlacementComposite(null); }}
            onClose={() => setShowCamera(false)}
          />
        )}
      </AnimatePresence>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 page-with-mobile-footer flex flex-col gap-6 sm:gap-8">
        {/* Heading */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-gold text-[11px] sm:text-xs font-mono tracking-[0.2em] uppercase mb-1.5">Step 2 of 2 — Placement</p>
          <h1 className="font-cinzel text-xl sm:text-3xl font-black text-ink leading-tight">Where does it go?</h1>
          <p className="text-muted text-xs sm:text-sm mt-1.5 sm:mt-2 leading-relaxed">
            Describe the placement area or upload a photo — then position your tattoo directly on the skin.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">

          {/* ── Left: Selected design — collapses to a compact card on mobile ── */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
            className="flex flex-col gap-3 sm:gap-4"
          >
            <p className="text-muted text-[11px] sm:text-xs font-mono uppercase tracking-widest">Your Tattoo Design</p>

            {/* Mobile: small horizontal card so it doesn't dominate the viewport */}
            <div
              className="lg:hidden flex items-center gap-3 bg-surface border border-gold/30 rounded-2xl p-3"
            >
              <div
                className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 relative"
                style={{ background: selectedDesign?.gradient }}
              >
                {selectedDesign?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selectedDesign.imageUrl}
                    alt={selectedDesign.styleName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted text-xs font-cinzel">
                    No image
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-gold text-[10px] font-mono tracking-widest uppercase">Selected</p>
                <p className="font-cinzel text-sm font-bold text-ink truncate">
                  {selectedDesign?.styleName ?? "—"}
                </p>
                <button
                  onClick={() => router.push(`/${sessionId}/design`)}
                  className="text-muted text-[10px] font-mono hover:text-gold transition-colors text-left mt-0.5"
                >
                  ← Change design
                </button>
              </div>
            </div>

            {/* Tablet / desktop: full square preview */}
            <div
              className="hidden lg:block rounded-2xl overflow-hidden border border-gold/30 aspect-square relative"
              style={{ background: selectedDesign?.gradient }}
            >
              {selectedDesign?.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selectedDesign.imageUrl}
                  alt={selectedDesign.styleName}
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-muted text-sm font-cinzel">
                  No image
                </div>
              )}
              <div className="absolute bottom-3 left-3">
                <span className="bg-black/70 backdrop-blur-sm text-gold text-xs font-cinzel font-bold px-3 py-1 rounded-lg border border-gold/20">
                  {selectedDesign?.styleName}
                </span>
              </div>
            </div>
          </motion.div>

          {/* ── Right: Placement input ─────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="flex flex-col gap-5"
          >
            {/* Mode tabs */}
            <div className="flex items-center gap-1 bg-surface rounded-xl border border-cleo-border p-1">
              {(["text", "upload", "camera"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleModeChange(mode)}
                  className={`flex-1 py-2 px-2 rounded-lg text-xs font-cinzel tracking-wide transition-all ${
                    inputMode === mode ? "bg-gold text-bg font-bold" : "text-muted hover:text-ink"
                  }`}
                >
                  {mode === "text" ? "📝 Describe" : mode === "upload" ? "📁 Upload" : "📷 Camera"}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {/* Text mode */}
              {inputMode === "text" && (
                <motion.div key="text" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    {QUICK_PLACEMENTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setPlacementText(p)}
                        className={`px-3 py-1.5 rounded-full text-xs font-cinzel border transition-all ${
                          placementText === p
                            ? "bg-gold text-bg border-gold font-bold"
                            : "bg-surface border-cleo-border text-muted hover:border-gold/40 hover:text-ink"
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">Or describe in detail</label>
                    <textarea
                      rows={3}
                      placeholder="e.g. Upper right arm, outer bicep area, about 4 inches wide…"
                      value={placementText}
                      onChange={(e) => setPlacementText(e.target.value)}
                      className="bg-surface border border-cleo-border rounded-xl px-4 py-3 text-ink text-sm placeholder:text-muted/50 focus:border-gold focus:outline-none transition-colors resize-none leading-relaxed"
                    />
                  </div>
                </motion.div>
              )}

              {/* Upload mode — step 1: upload body photo */}
              {inputMode === "upload" && !bodyPhoto && (
                <motion.div key="upload-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div
                    {...getRootProps()}
                    className={`rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-all ${
                      isDragActive ? "border-gold bg-gold/5" : "border-cleo-border hover:border-gold/40"
                    }`}
                  >
                    <input {...getInputProps()} />
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center text-2xl">+</div>
                      <p className="text-ink text-sm font-cinzel">Upload body photo</p>
                      <p className="text-muted text-xs">Photo of the skin area where the tattoo will go</p>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Camera mode — step 1: capture body photo */}
              {inputMode === "camera" && !bodyPhoto && (
                <motion.div key="camera-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <button
                    onClick={() => setShowCamera(true)}
                    className="w-full rounded-xl border-2 border-dashed border-cleo-border hover:border-gold/40 p-10 text-center transition-all"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center text-2xl">📷</div>
                      <p className="text-ink text-sm font-cinzel">Open Camera</p>
                      <p className="text-muted text-xs">Point at the placement area on the body</p>
                    </div>
                  </button>
                </motion.div>
              )}

              {/* Photo mode — step 2: interactive placement editor */}
              {isPhotoMode && bodyPhoto && !placementComposite && selectedDesign?.imageUrl && (
                <motion.div key="placement-editor" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <TattooPlacementEditor
                    bodyPhotoUrl={bodyPhoto}
                    tattooImageUrl={selectedDesign.imageUrl}
                    onConfirm={(composite) => setPlacementComposite(composite)}
                    onReset={() => { setBodyPhoto(null); setPlacementComposite(null); }}
                  />
                </motion.div>
              )}

              {/* Photo mode — step 3: composite confirmed, ready to generate */}
              {isPhotoMode && placementComposite && (
                <motion.div key="composite-ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
                  <p className="text-muted text-xs font-mono uppercase tracking-widest">Placement Confirmed</p>
                  <div className="rounded-xl overflow-hidden border border-gold/30 relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={placementComposite} alt="Placement composite" className="w-full h-auto object-contain" />
                    <div className="absolute top-2 right-2 bg-success/20 border border-success/40 text-success text-[10px] font-mono px-2 py-0.5 rounded-lg backdrop-blur-sm">
                      ✓ Placement set
                    </div>
                  </div>
                  <button
                    onClick={() => setPlacementComposite(null)}
                    className="text-muted text-xs font-cinzel hover:text-ink transition-colors text-left"
                  >
                    ↺ Re-adjust placement
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error */}
            {error && (
              <div className="bg-error/10 border border-error/40 rounded-xl px-4 py-3 flex items-start gap-3">
                {creditsError && (
                  <svg className="w-5 h-5 text-error flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-error text-xs leading-relaxed break-words ${creditsError ? "font-cinzel" : "font-mono"}`}>{error}</p>
                  {!creditsError && (
                    <p className="text-muted text-[10px] mt-1">
                      This is usually a transient AI service issue. Tap Retry to try again.
                    </p>
                  )}
                </div>
                {!creditsError && (
                  <button
                    onClick={() => { setError(null); handleGenerate(); }}
                    disabled={isGeneratingPlacement || !canGenerate}
                    className="flex-shrink-0 bg-gold text-bg font-cinzel font-bold text-[10px] tracking-[0.1em] uppercase px-3 py-2 rounded-lg border border-gold hover:bg-gold-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    ↺ Retry
                  </button>
                )}
              </div>
            )}

            <motion.button
              whileHover={canGenerate ? { scale: 1.02 } : {}}
              whileTap={canGenerate ? { scale: 0.97 } : {}}
              onClick={handleGenerate}
              disabled={!canGenerate || isGeneratingPlacement}
              className={`hidden sm:block w-full py-4 rounded-xl font-cinzel font-bold text-base tracking-[0.08em] uppercase border transition-all ${
                canGenerate && !isGeneratingPlacement
                  ? "bg-gold text-bg border-gold hover:bg-gold-light cursor-pointer shadow-[0_0_20px_rgba(201,168,76,0.2)]"
                  : "bg-surface-2 text-muted border-cleo-border cursor-not-allowed"
              }`}
            >
              {isGeneratingPlacement ? "Generating Preview…" : "✦ Generate Placement Preview"}
            </motion.button>
          </motion.div>
        </div>

        {/* ── Loading state ──────────────────────────────────────────── */}
        <AnimatePresence>
          {isGeneratingPlacement && (
            <motion.div
              key="loading"
              ref={loadingRef}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-6 py-10"
            >
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 rounded-full border-2 border-gold/20 animate-ping" />
                <div className="absolute inset-2 rounded-full border-2 border-gold/40 animate-spin" style={{ animationDuration: "2s" }} />
                <div className="absolute inset-4 rounded-full border-2 border-gold animate-spin" style={{ animationDuration: "1.4s", animationDirection: "reverse" }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-3 h-3 rounded-full bg-gold animate-pulse" />
                </div>
              </div>
              <div className="text-center">
                <p className="font-cinzel text-lg font-bold text-ink">Compositing Your Design…</p>
                <motion.p
                  key={stageIdx}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-muted text-sm mt-1"
                >
                  {STAGE_MESSAGES[stageIdx]}
                </motion.p>
                <p className="text-muted/60 text-[10px] font-mono tracking-widest mt-3 uppercase">
                  {elapsed}s elapsed · usually takes 2–3 min
                </p>
              </div>
              <div className="w-64 h-1 bg-surface-2 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gold rounded-full"
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              </div>
              <p className="text-muted/50 text-[10px] font-mono max-w-xs text-center">
                If this gets stuck past 4 minutes, AI service is likely congested — you can safely refresh and try again.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Result ────────────────────────────────────────────────── */}
        <AnimatePresence>
          {!isGeneratingPlacement && placementResults.length > 0 && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col gap-6"
            >
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="font-cinzel text-xl font-bold text-ink">
                  {placementResults.length > 1 ? "Placement Previews — pick one" : "Placement Preview"}
                </h2>
                <div className="flex items-center gap-2">
                  {sessionStatus === "completed" && (
                    <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-gold bg-gold/10 border border-gold/30 px-2.5 py-1 rounded-full">
                      ✓ Finalized
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                    <span className="text-success text-xs font-mono">AI Generated</span>
                  </div>
                </div>
              </div>

              <div className={`grid gap-4 ${placementResults.length > 1 ? "sm:grid-cols-2" : ""}`}>
                {placementResults.map((result) => {
                  const label = getModelLabel(result.model);
                  const isFinalizingThis = finalizingDbId === result.dbId;
                  return (
                    <div key={result.dbId} className="flex flex-col gap-3">
                      <div className="rounded-2xl overflow-hidden border border-gold/20 relative bg-surface-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={result.url}
                          alt="Tattoo placement preview"
                          className="w-full object-contain max-h-[480px]"
                        />
                        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between pointer-events-none">
                          <div className="bg-black/70 backdrop-blur-sm text-ink/90 text-xs font-cinzel px-3 py-1.5 rounded-lg">
                            {placementText || "Body placement preview"}
                          </div>
                          <div className="bg-black/70 backdrop-blur-sm text-gold text-[10px] font-mono px-2 py-1 rounded-lg border border-gold/20">
                            {label ?? "AI Preview"}
                          </div>
                        </div>
                      </div>
                      {sessionStatus !== "completed" && (
                        <motion.button
                          whileHover={finalizingDbId ? {} : { scale: 1.02 }}
                          whileTap={finalizingDbId ? {} : { scale: 0.97 }}
                          onClick={() => handleFinalize(result.dbId)}
                          disabled={!!finalizingDbId}
                          className="w-full bg-gold text-bg font-cinzel font-bold text-sm tracking-[0.08em] uppercase py-3.5 rounded-xl border border-gold hover:bg-gold-light transition-colors cursor-pointer shadow-[0_0_24px_rgba(201,168,76,0.3)] disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {isFinalizingThis ? "Saving…" : `✦ Use This${label ? ` (${label})` : ""}`}
                        </motion.button>
                      )}
                    </div>
                  );
                })}
              </div>

              {sessionStatus !== "completed" && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleReset}
                  className="py-3 rounded-xl font-cinzel text-sm tracking-wide border border-cleo-border text-muted hover:text-ink hover:border-gold/40 transition-all cursor-pointer"
                >
                  ↺ Try Different Placement
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Sticky mobile CTA ───────────────────────────────────────── */}
      <div className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-bg/95 backdrop-blur-md border-t border-cleo-border px-4 pt-3 pb-safe">
        {isGeneratingPlacement ? (
          <button
            disabled
            className="w-full py-3.5 rounded-xl font-cinzel font-bold text-sm tracking-[0.08em] uppercase bg-surface-2 text-muted border border-cleo-border cursor-not-allowed"
          >
            Generating Preview…
          </button>
        ) : placementResults.length > 0 ? (
          // Finalize now lives on each preview tile above (disambiguates
          // which one, once there are two) — this bar just offers retry.
          sessionStatus !== "completed" && (
            <button
              onClick={handleReset}
              className="w-full py-3 rounded-xl font-cinzel font-bold text-[11px] tracking-[0.06em] uppercase border border-cleo-border text-muted cursor-pointer"
            >
              ↺ Try Different Placement
            </button>
          )
        ) : (
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={`w-full py-3.5 rounded-xl font-cinzel font-bold text-sm tracking-[0.08em] uppercase border transition-colors ${
              canGenerate
                ? "bg-gold text-bg border-gold cursor-pointer shadow-[0_0_18px_rgba(201,168,76,0.25)]"
                : "bg-surface-2 text-muted border-cleo-border cursor-not-allowed"
            }`}
          >
            {canGenerate ? "✦ Generate Preview" : inputMode === "text" ? "Describe placement first" : "Confirm placement first"}
          </button>
        )}
      </div>
    </>
  );
}
