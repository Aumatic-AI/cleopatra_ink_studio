"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useDropzone } from "react-dropzone";
import { useAppStore } from "@/store/app-store";
import type { DesignVariant, ModelChoice } from "@/store/app-store";
import ModelChoiceSelector from "@/components/design/ModelChoiceSelector";
import CameraCapture from "@/components/camera/CameraCapture";
import StyleSelect from "@/components/ui/StyleSelect";
import PinterestSearch from "@/components/pinterest/PinterestSearch";
import { uploadPhotoDirect, uploadBase64Direct } from "@/lib/browser-upload";
import { TATTOO_COLORS } from "@/lib/tattoo-colors";
import { TypographyGenerator } from "@/components/typography/TypographyGenerator";
import ColorPickerModal from "@/components/design/ColorPickerModal";
import PreviousDesignsModal from "@/components/design/PreviousDesignsModal";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";

const supabase = createSupabaseBrowserClient();

export default function DesignPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const router = useRouter();

  const {
    tattooStyle, setTattooStyle,
    tattooDescription, setTattooDescription,
    targetBodyArea, setTargetBodyArea,
    referenceImages, addReferenceImage, removeReferenceImage, replaceReferenceImage,
    selectedColors, toggleColor, clearColors,
    selectDesign,
    customerName,
    persistDesigns,
    hydrateFromSession,
    flowType, setFlowType, reworkMode, setReworkMode, reworkPhoto, setReworkPhoto,
    setPendingGeneration, setIsTextTattoo: setStoreIsTextTattoo,
    setInitialGenerationModel,
    sessionId: storeSessionId,
  } = useAppStore();

  const [hydrating, setHydrating] = useState(false);

  // Coming back to the same session already live in the store (e.g. from
  // Chat) — restore the tab/photo/mode instead of resetting to a blank form.
  const sameSession = storeSessionId === sessionId;

  // ── Design mode: AI generation vs direct customer upload vs rework ──
  const [designMode, setDesignMode] = useState<"ai" | "direct" | "rework">(
    sameSession && (flowType === "rework" || flowType === "direct") ? flowType : "ai"
  );
  const [directImageUrl, setDirectImageUrl] = useState<string | null>(null);
  const [directImagePreview, setDirectImagePreview] = useState<string | null>(null);
  const [directStyleName, setDirectStyleName] = useState<string | null>(null);
  const [uploadingDirect, setUploadingDirect] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [proceedingDirect, setProceedingDirect] = useState(false);
  const [showPreviousDesigns, setShowPreviousDesigns] = useState(false);

  // Rework (cover-up / extend)
  const [reworkPhotoPreview, setReworkPhotoPreview] = useState<string | null>(
    sameSession ? reworkPhoto : null
  );
  const [reworkModeLocal, setReworkModeLocal] = useState<"cover" | "extend">(
    sameSession ? reworkMode : "cover"
  );

  const [isTextTattoo, setIsTextTattoo] = useState(false);
  const [showTypographyModal, setShowTypographyModal] = useState(false);
  // Shared by both the AI Design and Rework tabs — which model(s) generate
  // the first batch. Chat has its own, separate, two-option choice for every
  // refinement after that.
  const [modelChoice, setModelChoice] = useState<ModelChoice>("both");
  const [showColorModal, setShowColorModal] = useState(false);
  const [textTattooRefUrl, setTextTattooRefUrl] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancedVariations, setEnhancedVariations] = useState<string[] | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"upload" | "camera" | "pinterest">("upload");
  const [showCamera, setShowCamera] = useState(false);
  // Maps blob URL → Pinterest pin ID so we can show an "Added" badge in the
  // search grid and prevent accidental duplicates. Cleared when the matching
  // reference image is removed.
  const [pinIdByUrl, setPinIdByUrl] = useState<Record<string, string>>({});

  // Restore state from Supabase on mount (handles full-page reload mid-session).
  // The page renders immediately from localStorage (Zustand persist). Supabase
  // hydration runs in the background and fills in anything missing or stale.
  // Redirect only fires after hydration confirms data is genuinely absent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Already working on this exact session in this tab (e.g. just came
      // back from Chat) — the store already has the live, current state,
      // which can be ahead of the DB (a description typed but not yet
      // generated/saved). Re-hydrating from the DB here would stomp that.
      if (storeSessionId !== sessionId) {
        await hydrateFromSession(sessionId);
      }
      if (!cancelled) setHydrating(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hydrateFromSession]);

  useEffect(() => {
    // Wait until hydration has confirmed state before redirecting — prevents
    // a blank-store first render from bouncing the user away.
    if (!hydrating) return;
    if (!customerName) { router.replace("/"); return; }
    // Deliberately no "already has results, send to Chat instead" redirect
    // here — that used to live in this effect, but it can't tell a fresh
    // external visit (where that redirect is the right call) apart from a
    // deliberate Back-click from Chat (where it isn't): this effect reruns
    // on every mount, including in-flow back-navigation, and would bounce
    // the designer right back to the screen they just chose to leave. That
    // decision now belongs entirely to the entry-point routers instead —
    // SessionOverview's `continueUrl` and customer/[userId]'s `resumeUrl` —
    // which run once, at the moment a session is actually opened, and
    // already send it to the correct screen from the start. Once inside the
    // flow, navigation between Design/Chat/Placement stays fully free, both
    // ways — see AGENTS.md's "Resuming a session must check what actually
    // happened" note for the entry-point routing rule this defers to.
  }, [hydrating, customerName, router]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".heic"] },
    maxFiles: 5,
    onDrop: (files) => {
      files.forEach((f) => addReferenceImage(URL.createObjectURL(f)));
    },
  });

  function handleRemoveReference(index: number) {
    const url = referenceImages[index];
    if (url && pinIdByUrl[url]) {
      setPinIdByUrl((prev) => {
        const next = { ...prev };
        delete next[url];
        return next;
      });
    }
    removeReferenceImage(index);
  }

  async function handleAddPinterestPin(blobUrl: string, pin: { id: string }) {
    // Add the blob URL immediately so the UI responds instantly
    addReferenceImage(blobUrl);
    setPinIdByUrl((prev) => ({ ...prev, [blobUrl]: pin.id }));

    // Upload to Supabase Storage in the background so the image is
    // persisted permanently (blob URLs die on page refresh and can't
    // be listed from storage for the admin overview).
    try {
      const permanentUrl = await uploadPhotoDirect(blobUrl, sessionId, "refs");
      // Swap blob URL → permanent Supabase Storage URL
      replaceReferenceImage(blobUrl, permanentUrl);
      setPinIdByUrl((prev) => {
        const next = { ...prev };
        delete next[blobUrl];
        return { ...next, [permanentUrl]: pin.id };
      });
      URL.revokeObjectURL(blobUrl); // free browser memory
    } catch (err) {
      console.warn("Pinterest image upload failed — keeping blob URL:", err);
      // Blob URL stays as fallback; image will still work for this session
    }
  }

  const addedPinIds = referenceImages
    .map((url) => pinIdByUrl[url])
    .filter((id): id is string => Boolean(id));

  // ── Typography Handler ────────────────────────────────────
  async function handleTypographyGenerated(dataUrl: string, font: string) {
    setUploadingDirect(true);
    try {
      const permanentUrl = await uploadBase64Direct(dataUrl, sessionId, "designs");

      addReferenceImage(permanentUrl);
      setTextTattooRefUrl(permanentUrl);
      
      const { setTextTattooDetails } = useAppStore.getState();
      setTextTattooDetails(font);
      
      setShowTypographyModal(false);
    } catch (err) {
      console.error("Typography save failed:", err);
    } finally {
      setUploadingDirect(false);
    }
  }

  // ── Direct upload handlers ────────────────────────────────
  async function handleDirectFileDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    setDirectError(null);
    setUploadingDirect(true);

    // Show a local preview immediately
    const previewUrl = URL.createObjectURL(file);
    setDirectImagePreview(previewUrl);
    setDirectImageUrl(null);
    setDirectStyleName(null);

    try {
      // Browser-side upload, not /api/upload-ref — server-side Supabase
      // writes are unreliable on this machine (see AGENTS.md); the
      // browser's own network stack isn't.
      const url = await uploadPhotoDirect(previewUrl, sessionId, "designs");
      setDirectImageUrl(url);
      URL.revokeObjectURL(previewUrl);
      setDirectImagePreview(url);
    } catch (err) {
      setDirectError((err as Error).message);
      setDirectImagePreview(null);
    } finally {
      setUploadingDirect(false);
    }
  }

  async function handleProceedDirect() {
    if (!directImageUrl) return;
    setProceedingDirect(true);
    try {
      setFlowType("direct");
      const design: DesignVariant = {
        id: `direct-${Date.now()}`,
        imageUrl: directImageUrl,
        gradient: gradients[0],
        patternType: "mandala",
        styleName: directStyleName ?? "Customer Design",
      };
      const [persisted] = await persistDesigns([design]);
      const finalDesign = persisted ?? design;
      // Deliberately not finishGenerating() here — nothing in the Upload
      // Existing flow reads generatedDesigns; only selectedDesign (below)
      // matters, which Placement actually reads.
      selectDesign(finalDesign);
      // sessions.flow_type defaults to 'ai_design' in the DB — without this
      // write, reopening this session later re-hydrates flowType back to
      // 'ai_design', and every entry-point router (SessionOverview's
      // continueUrl, customer/[userId]'s resumeUrl) misreads this as a real
      // AI Design session instead of an Upload Existing one — see AGENTS.md's
      // "`flow_type` has three values, not two" note. Error MUST be checked
      // here — a stale DB check constraint silently rejected every 'direct'
      // write for a while (constraint said only ai_design/rework were legal)
      // and this line swallowed it, so every Upload Existing session quietly
      // stayed flagged 'ai_design' and resumed to Design instead of Placement.
      const { error: flowTypeErr } = await supabase.from("sessions").update({ flow_type: "direct" }).eq("id", sessionId);
      if (flowTypeErr) throw new Error(`Couldn't save the upload type: ${flowTypeErr.message}`);
      router.push(`/${sessionId}/placement`);
    } catch (err) {
      setDirectError((err as Error).message);
      setProceedingDirect(false);
    }
  }

  const {
    getRootProps: getReworkRootProps,
    getInputProps: getReworkInputProps,
    isDragActive: isReworkDragActive,
  } = useDropzone({
    accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".heic"] },
    maxFiles: 1,
    onDrop: (files) => {
      if (files[0]) setReworkPhotoPreview(URL.createObjectURL(files[0]));
    },
  });

  async function handleGenerateRework() {
    if (!reworkPhotoPreview || !tattooDescription.trim()) return;
    setFlowType("rework");
    setReworkMode(reworkModeLocal);
    setReworkPhoto(reworkPhotoPreview);
    setInitialGenerationModel(modelChoice);
    setPendingGeneration(true);
    // The chat screen re-reads flow_type from the DB as its source of truth
    // (so reopening a session later still shows the right context) — every
    // session row is created with the 'ai_design' default, so without this
    // write the chat screen would silently route every Rework generation
    // through the AI-Design endpoint instead.
    await supabase.from("sessions").update({ flow_type: "rework", rework_mode: reworkModeLocal }).eq("id", sessionId);
    router.push(`/${sessionId}/chat`);
  }

  const {
    getRootProps: getDirectRootProps,
    getInputProps: getDirectInputProps,
    isDragActive: isDirectDragActive,
  } = useDropzone({
    accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".heic"] },
    maxFiles: 1,
    onDrop: handleDirectFileDrop,
  });

  const canGenerate = tattooDescription.trim().length > 0 && referenceImages.length > 0;

  // Only used by the "Upload Existing" direct-design path below.
  const gradients = [
    "radial-gradient(ellipse at 50% 40%, #4a0080 0%, #1a0030 40%, #0d0010 100%)",
    "radial-gradient(ellipse at 40% 35%, #8b0000 0%, #3a0000 40%, #0a0000 100%)",
    "radial-gradient(ellipse at 45% 45%, #1a2a4a 0%, #0a1a2a 50%, #000a0d 100%)",
    "radial-gradient(ellipse at 45% 45%, #c9a84c 0%, #6b4800 50%, #1a1000 100%)",
    "radial-gradient(ellipse at 55% 40%, #1a3a1a 0%, #0a1a08 50%, #000500 100%)",
  ];

  function handleGenerate() {
    if (!canGenerate) return;
    setFlowType("ai_design");
    setStoreIsTextTattoo(isTextTattoo);
    setInitialGenerationModel(modelChoice);
    setPendingGeneration(true);
    router.push(`/${sessionId}/chat`);
  }

  return (
    <>
      <AnimatePresence>
        {showCamera && (
          <CameraCapture
            onCapture={(url) => {
              setShowCamera(false);
              if (designMode === "direct") {
                // In direct mode, camera capture is the design itself
                setDirectError(null);
                setDirectImagePreview(url);
                setDirectImageUrl(null);
                setDirectStyleName(null);
                setUploadingDirect(true);
                uploadPhotoDirect(url, sessionId, "designs")
                  .then((permanentUrl) => { setDirectImageUrl(permanentUrl); setDirectImagePreview(permanentUrl); })
                  .catch(() => setDirectError("Upload failed — please try again"))
                  .finally(() => setUploadingDirect(false));
              } else {
                addReferenceImage(url);
              }
            }}
            onClose={() => setShowCamera(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Previous Designs Modal (Direct-upload mode) ───────────── */}
      <AnimatePresence>
        {showPreviousDesigns && (
          <PreviousDesignsModal
            onSelect={(url, styleName) => {
              setDirectImageUrl(url);
              setDirectImagePreview(url);
              setDirectStyleName(styleName);
              setDirectError(null);
              setShowPreviousDesigns(false);
            }}
            onClose={() => setShowPreviousDesigns(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Typography Modal ─────────────────────────────────────── */}
      <AnimatePresence>
        {showTypographyModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8 overflow-y-auto"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="w-full max-w-xl my-auto"
            >
              <TypographyGenerator
                onDesignGenerated={handleTypographyGenerated}
                onCancel={() => {
                  setShowTypographyModal(false);
                  setIsTextTattoo(false); // Cancel means we didn't add the text
                }}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>


      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 page-with-mobile-footer flex flex-col gap-6 sm:gap-8">
        {/* Heading */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-gold text-[11px] sm:text-xs font-mono tracking-[0.2em] uppercase mb-1.5">Step 1 of 2 — Design</p>
          <h1 className="font-cinzel text-xl sm:text-3xl font-black text-ink leading-tight">
            {designMode === "ai" ? "Describe your tattoo" : "Upload existing design"}
          </h1>
          <p className="text-muted text-xs sm:text-sm mt-1.5 sm:mt-2 leading-relaxed">
            {designMode === "ai"
              ? "Choose a style, describe your idea, and optionally add a reference image."
              : designMode === "direct"
              ? "Customer has a ready design — upload it and proceed directly to placement."
              : "Customer has an existing tattoo — upload a photo and describe the cover-up or extension."}
          </p>
        </motion.div>

        {/* ── Mode switcher ──────────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.04 }}
          className="flex gap-2 p-1 bg-surface rounded-xl border border-cleo-border w-full flex-wrap sm:flex-nowrap sm:w-fit">
          {[
            {
              mode: "ai" as const,
              label: "AI Design",
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
              )
            },

            {
              mode: "direct" as const,
              label: "Upload Existing",
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              )
            },

            {
              mode: "rework" as const,
              label: "Rework",
              icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L15.6 5.6" />
                </svg>
              )
            },
          ].map(({ mode: m, label, icon }) => (
            <button
              key={m}
              onClick={() => setDesignMode(m)}
              className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-cinzel font-bold text-xs tracking-[0.08em] uppercase transition-all cursor-pointer whitespace-nowrap ${
                designMode === m
                  ? "bg-gold text-bg shadow-[0_0_12px_rgba(201,168,76,0.3)]"
                  : "text-muted hover:text-ink hover:bg-surface-2"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </motion.div>

        {/* ── Direct upload card ─────────────────────────────────── */}
        {designMode === "direct" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="bg-surface rounded-2xl border border-cleo-border p-4 sm:p-6 flex flex-col gap-5"
          >
            {!directImagePreview ? (
              /* Three equal ways to get the design in */
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Upload / drag & drop */}
                <div
                  {...getDirectRootProps()}
                  className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-8 px-4 text-center cursor-pointer transition-colors ${
                    isDirectDragActive ? "border-gold bg-gold/5" : "border-cleo-border hover:border-gold/50 hover:bg-surface-2"
                  }`}
                >
                  <input {...getDirectInputProps()} />
                  {uploadingDirect ? (
                    <div className="flex flex-col items-center gap-3 py-2">
                      <div className="w-7 h-7 border-2 border-gold border-t-transparent rounded-full animate-spin" />
                      <p className="text-muted text-xs font-mono">Uploading…</p>
                    </div>
                  ) : (
                    <>
                      <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center">
                        <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-ink font-cinzel font-bold text-sm">
                          {isDirectDragActive ? "Drop here" : "Upload Image"}
                        </p>
                        <p className="text-muted text-[11px] mt-1">Drag & drop or click · JPG, PNG, WEBP</p>
                      </div>
                    </>
                  )}
                </div>

                {/* Camera capture */}
                <button
                  type="button"
                  onClick={() => setShowCamera(true)}
                  className="flex flex-col items-center justify-center gap-3 rounded-xl border border-cleo-border hover:border-gold/50 hover:bg-surface-2 py-8 px-4 text-center transition-colors cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center">
                    <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.25 2.25 0 018.978 4.5h6.044a2.25 2.25 0 012.15 1.675l.512 1.876c.083.303.348.51.66.51h.001a2.25 2.25 0 012.155 2.278v6.816A2.25 2.25 0 0118.25 19.9H5.75A2.25 2.25 0 013.5 17.65v-6.816c0-1.216.876-2.222 2.155-2.278.312 0 .577-.207.66-.51l.512-1.87z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-ink font-cinzel font-bold text-sm">Use Camera</p>
                    <p className="text-muted text-[11px] mt-1">Capture a live photo</p>
                  </div>
                </button>

                {/* Browse previous designs */}
                <button
                  type="button"
                  onClick={() => setShowPreviousDesigns(true)}
                  className="flex flex-col items-center justify-center gap-3 rounded-xl border border-cleo-border hover:border-gold/50 hover:bg-surface-2 py-8 px-4 text-center transition-colors cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center">
                    <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <rect x="3.75" y="3.75" width="7" height="7" rx="1.25" strokeLinecap="round" strokeLinejoin="round" />
                      <rect x="13.25" y="3.75" width="7" height="7" rx="1.25" strokeLinecap="round" strokeLinejoin="round" />
                      <rect x="3.75" y="13.25" width="7" height="7" rx="1.25" strokeLinecap="round" strokeLinejoin="round" />
                      <rect x="13.25" y="13.25" width="7" height="7" rx="1.25" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-ink font-cinzel font-bold text-sm">Browse Previous</p>
                    <p className="text-muted text-[11px] mt-1">Pick an existing design</p>
                  </div>
                </button>
              </div>
            ) : (
              /* Preview + actions */
              <div className="flex flex-col gap-4">
                <div className="relative rounded-xl overflow-hidden border-2 border-gold/40 aspect-square max-h-72 mx-auto w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={directImagePreview} alt="Customer design" className="w-full h-full object-contain bg-surface-2" />
                  {uploadingDirect && (
                    <div className="absolute inset-0 bg-bg/70 flex items-center justify-center">
                      <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <button
                    onClick={() => { setDirectImagePreview(null); setDirectImageUrl(null); setDirectStyleName(null); setDirectError(null); }}
                    className="absolute top-2 right-2 w-8 h-8 rounded-full bg-bg/80 border border-cleo-border text-muted hover:text-error transition-colors flex items-center justify-center text-lg cursor-pointer"
                  >
                    ×
                  </button>
                </div>

                {directError && (
                  <p className="text-error text-sm font-mono text-center">{directError}</p>
                )}

                <motion.button
                  onClick={handleProceedDirect}
                  disabled={!directImageUrl || uploadingDirect || proceedingDirect}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  className="w-full py-4 bg-gold text-bg font-cinzel font-bold text-base tracking-[0.1em] uppercase rounded-xl border border-gold hover:bg-gold-light transition-colors shadow-[0_0_24px_rgba(201,168,76,0.2)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {proceedingDirect ? "Saving…" : uploadingDirect ? "Uploading…" : "✦ Proceed to Placement →"}
                </motion.button>
              </div>
            )}
          </motion.div>
        )}

        {/* ── Rework (cover-up / extend) card ───────────────────── */}
        {designMode === "rework" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="bg-surface rounded-2xl border border-cleo-border p-4 sm:p-6 flex flex-col gap-5"
          >
            {/* Photo of the existing tattoo */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
                Photo of Existing Tattoo <span className="text-error/70 normal-case font-mono">*required</span>
              </label>
              {!reworkPhotoPreview ? (
                <div
                  {...getReworkRootProps()}
                  className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-10 px-6 text-center cursor-pointer transition-colors ${
                    isReworkDragActive ? "border-gold bg-gold/5" : "border-cleo-border hover:border-gold/50 hover:bg-surface-2"
                  }`}
                >
                  <input {...getReworkInputProps()} />
                  <div className="w-12 h-12 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center">
                    <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-ink font-cinzel font-bold text-sm">
                      {isReworkDragActive ? "Drop the photo here" : "Drop a photo or click to browse"}
                    </p>
                    <p className="text-muted text-xs mt-1">A clear, well-lit photo of the tattoo to cover or extend</p>
                  </div>
                </div>
              ) : (
                <div className="relative rounded-xl overflow-hidden border-2 border-gold/40 aspect-square max-h-72 mx-auto w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={reworkPhotoPreview} alt="Existing tattoo" className="w-full h-full object-contain bg-surface-2" />
                  <button
                    onClick={() => setReworkPhotoPreview(null)}
                    className="absolute top-2 right-2 w-8 h-8 rounded-full bg-bg/80 border border-cleo-border text-muted hover:text-error transition-colors flex items-center justify-center text-lg cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* Mode: cover vs extend */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">What should happen to it?</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: "cover" as const, label: "Cover Completely", desc: "Fully replace the old tattoo with new art" },
                  { key: "extend" as const, label: "Extend & Blend", desc: "Build new art around and with the existing ink" },
                ]).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setReworkModeLocal(opt.key)}
                    className={`text-left px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                      reworkModeLocal === opt.key
                        ? "bg-gold/10 border-gold text-ink"
                        : "bg-bg border-cleo-border text-muted hover:border-gold/40"
                    }`}
                  >
                    <p className="font-cinzel font-bold text-xs uppercase tracking-wide">{opt.label}</p>
                    <p className="text-[10px] mt-0.5 leading-snug opacity-80">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>


            {/* Description */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
                Describe the New Design <span className="text-error/70 normal-case font-mono">*required</span>
              </label>
              <textarea
                rows={4}
                placeholder={
                  reworkModeLocal === "cover"
                    ? "e.g. A large phoenix rising, wings spread wide, fully covering the old design in black & grey realism…"
                    : "e.g. Extend the existing rose vine up the forearm, blending in more roses and leaves in the same style…"
                }
                value={tattooDescription}
                onChange={(e) => setTattooDescription(e.target.value)}
                className="bg-bg border border-cleo-border rounded-xl px-4 py-3.5 text-ink text-sm placeholder:text-muted/50 focus:border-gold focus:outline-none transition-colors resize-none leading-relaxed"
              />
            </div>

            <ModelChoiceSelector value={modelChoice} onChange={setModelChoice} />

            <motion.button
              whileHover={reworkPhotoPreview && tattooDescription.trim() ? { scale: 1.02 } : {}}
              whileTap={reworkPhotoPreview && tattooDescription.trim() ? { scale: 0.97 } : {}}
              onClick={handleGenerateRework}
              disabled={!reworkPhotoPreview || !tattooDescription.trim()}
              className={`w-full py-4 rounded-xl font-cinzel font-bold text-base tracking-[0.08em] uppercase transition-all border ${
                reworkPhotoPreview && tattooDescription.trim()
                  ? "bg-gold text-bg border-gold hover:bg-gold-light cursor-pointer shadow-[0_0_18px_rgba(201,168,76,0.25)]"
                  : "bg-surface-2 text-muted border-cleo-border cursor-not-allowed"
              }`}
            >
              {!reworkPhotoPreview ? "Add a photo of the existing tattoo" : !tattooDescription.trim() ? "Describe the new design" : "✦ Generate Rework"}
            </motion.button>
          </motion.div>
        )}

        {/* ── AI Design mode content ────────────────────────────── */}
        {designMode === "ai" && <>

        {/* ── Input card ─────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08 }}
          className="bg-surface rounded-2xl border border-cleo-border p-4 sm:p-6 flex flex-col gap-5"
        >
          {/* Style picker */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
              Tattoo Style <span className="text-muted/50 normal-case">(optional but recommended)</span>
            </label>
            <StyleSelect value={tattooStyle} onChange={setTattooStyle} />
          </div>

          {/* Body placement hint */}
          <BodyAreaPicker value={targetBodyArea} onChange={setTargetBodyArea} />

          {/* Description */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">Describe your tattoo</label>
              {tattooDescription.trim().length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    setEnhancing(true);
                    setEnhancedVariations(null);
                    setEnhanceError(null);
                    try {
                      const res = await fetch("/api/enhance-prompt", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ description: tattooDescription, style: tattooStyle }),
                      });
                      const json = await res.json();
                      if (!res.ok) throw new Error(json.error ?? "Enhancement failed");
                      setEnhancedVariations(json.variations);
                    } catch (err) {
                      setEnhanceError((err as Error).message);
                    } finally {
                      setEnhancing(false);
                    }
                  }}
                  disabled={enhancing}
                  className="flex items-center gap-1.5 text-[10px] font-cinzel font-bold tracking-[0.08em] uppercase text-gold hover:text-gold-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {enhancing ? (
                    <>
                      <div className="w-3 h-3 border border-gold border-t-transparent rounded-full animate-spin" />
                      Enhancing…
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                      Enhance with AI
                    </>
                  )}
                </button>
              )}
            </div>
            <textarea
              rows={4}
              placeholder={
                tattooStyle
                  ? `Describe your ${tattooStyle} tattoo… e.g. A fierce lion face with a detailed mane, surrounded by geometric shapes and fine line roses…`
                  : "e.g. A detailed mandala with lotus petals, geometric outer rings, and a crescent moon at the top. Fine lines, sacred geometry feel…"
              }
              value={tattooDescription}
              onChange={(e) => { setTattooDescription(e.target.value); setEnhancedVariations(null); setEnhanceError(null); }}
              className="bg-bg border border-cleo-border rounded-xl px-4 py-3.5 text-ink text-sm placeholder:text-muted/50 focus:border-gold focus:outline-none transition-colors resize-none leading-relaxed"
            />

            {/* Enhance error */}
            {enhanceError && (
              <p className="text-error text-[10px] font-mono">{enhanceError}</p>
            )}

            {/* Enhanced variations panel */}
            <AnimatePresence>
              {enhancedVariations && enhancedVariations.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-mono tracking-[0.15em] uppercase text-gold">
                      ✦ {enhancedVariations.length} enhanced versions — tap to use
                    </p>
                    <button
                      type="button"
                      onClick={() => setEnhancedVariations(null)}
                      className="text-muted hover:text-ink text-xs transition-colors cursor-pointer"
                    >
                      ✕ Dismiss
                    </button>
                  </div>
                  {enhancedVariations.map((variation, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { setTattooDescription(variation); setEnhancedVariations(null); }}
                      className="text-left w-full bg-bg border border-cleo-border hover:border-gold/50 hover:bg-gold/5 rounded-xl px-4 py-3 transition-colors cursor-pointer group"
                    >
                      <p className="text-[10px] font-mono text-gold/70 mb-1 group-hover:text-gold transition-colors">
                        Version {i + 1}
                      </p>
                      <p className="text-ink text-xs leading-relaxed">{variation}</p>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch">
          {/* Text tattoo toggle */}
          <div className="flex items-center gap-3 p-3 bg-bg rounded-xl border border-cleo-border h-full">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-cinzel font-bold text-ink leading-tight">
                Text Tattoo Mode
              </p>
              <p className="text-muted text-[10px] mt-0.5 leading-snug">
                {isTextTattoo
                  ? "Uses a text-optimised model — accurate fonts, lettering & mixed elements"
                  : "Turn on if the tattoo contains words, names, quotes, or lettering"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !isTextTattoo;
                setIsTextTattoo(next);
                if (next) {
                  setShowTypographyModal(true);
                } else {
                  if (textTattooRefUrl) {
                    const idx = referenceImages.indexOf(textTattooRefUrl);
                    if (idx !== -1) {
                      removeReferenceImage(idx);
                    }
                    setTextTattooRefUrl(null);
                    const { setTextTattooDetails } = useAppStore.getState();
                    setTextTattooDetails(null);
                  }
                }
              }}
              aria-pressed={isTextTattoo}
              className={`flex-shrink-0 w-11 h-6 rounded-full border transition-colors cursor-pointer flex items-center px-0.5 ${
                isTextTattoo
                  ? "bg-gold border-gold justify-end"
                  : "bg-surface-2 border-cleo-border justify-start"
              }`}
            >
              <span className={`w-5 h-5 rounded-full shadow transition-all ${isTextTattoo ? "bg-bg" : "bg-muted"}`} />
            </button>
          </div>

          {/* Colour palette */}
          <div className="flex flex-col gap-2 p-3 bg-bg rounded-xl border border-cleo-border h-full">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
                Color Palette <span className="text-muted/40 normal-case">(optional)</span>
              </label>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <span className={selectedColors.length > 0 ? "text-gold" : "text-muted/60"}>
                  {selectedColors.length === 0
                    ? "Black & grey"
                    : `${selectedColors.length} ink${selectedColors.length === 1 ? "" : "s"}`}
                </span>
                {selectedColors.length > 0 && (
                  <button
                    onClick={() => clearColors()}
                    className="text-muted hover:text-gold transition-colors uppercase tracking-wider cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {selectedColors.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => toggleColor(hex)}
                  title={`${hex.toUpperCase()} — tap to remove`}
                  aria-label={`Remove ${hex.toUpperCase()}`}
                  className="relative flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 rounded-md cursor-pointer ring-1 ring-inset ring-gold shadow-[0_0_0_2px_rgba(201,168,76,0.35)] transition-transform hover:-translate-y-0.5"
                  style={{ backgroundColor: hex }}
                >
                  <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-error text-white text-[10px] flex items-center justify-center leading-none shadow-sm">
                    ×
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowColorModal(true)}
                title="Add a color"
                aria-label="Add a color"
                className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 rounded-md border border-dashed border-cleo-border hover:border-gold/50 text-muted hover:text-gold transition-colors cursor-pointer flex items-center justify-center text-base leading-none"
              >
                +
              </button>
            </div>
          </div>
          </div>

          {showColorModal && (
            <ColorPickerModal
              presets={TATTOO_COLORS}
              onPick={(hex) => {
                if (!selectedColors.some((c) => c.toUpperCase() === hex.toUpperCase())) {
                  toggleColor(hex);
                }
              }}
              onClose={() => setShowColorModal(false)}
            />
          )}

          <ModelChoiceSelector
            value={modelChoice}
            onChange={setModelChoice}
            disabledNote={
              isTextTattoo
                ? "Locked to Nano Banana Pro while Text Tattoo Mode is on — it renders lettering far more accurately."
                : undefined
            }
          />

          {/* Reference images */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
                  Reference Images <span className="text-error/70 normal-case font-mono">*required</span>
                </label>
                {referenceImages.length > 0 && (
                  <span className="text-[10px] font-mono text-gold bg-gold/10 border border-gold/30 px-2 py-0.5 rounded-full">
                    {referenceImages.length}/5
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 bg-bg rounded-lg border border-cleo-border p-0.5 w-full sm:w-auto">
                {(["upload", "camera", "pinterest"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setInputMode(mode)}
                    className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-cinzel tracking-wide transition-all whitespace-nowrap ${inputMode === mode ? "bg-gold text-bg font-bold" : "text-muted hover:text-ink"}`}
                  >
                    {mode === "upload" ? "📁 Upload" : mode === "camera" ? "📷 Camera" : "🔍 Pinterest"}
                  </button>
                ))}
              </div>
            </div>

            {/* Uploaded thumbnails grid */}
            <AnimatePresence>
              {referenceImages.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="grid grid-cols-3 sm:grid-cols-5 gap-2"
                >
                  {referenceImages.map((url, i) => (
                    <motion.div
                      key={url}
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85 }}
                      transition={{ duration: 0.2 }}
                      className="relative group rounded-xl overflow-hidden border border-cleo-border bg-surface-2"
                      style={{ aspectRatio: "1" }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`Reference ${i + 1}`} className="w-full h-full object-cover" />
                      <button
                        onClick={() => handleRemoveReference(i)}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center leading-none shadow-sm"
                      >
                        ×
                      </button>
                      <div className="absolute bottom-1 left-1 bg-black/60 text-white/70 text-[9px] font-mono px-1.5 py-0.5 rounded">
                        {i + 1}
                      </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Add more / first upload */}
            <AnimatePresence mode="wait">
              {referenceImages.length < 5 && inputMode === "upload" && (
                <motion.div key="upload" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div
                    {...getRootProps()}
                    className={`rounded-xl border-2 border-dashed transition-all cursor-pointer ${
                      isDragActive ? "border-gold bg-gold/5" : "border-cleo-border hover:border-gold/40"
                    } ${referenceImages.length > 0 ? "py-4" : "py-7"}`}
                  >
                    <input {...getInputProps()} />
                    <div className="flex items-center justify-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center text-gold text-lg flex-shrink-0">+</div>
                      {referenceImages.length === 0 ? (
                        <div>
                          <p className="text-ink text-sm font-cinzel">Drop images or click to browse</p>
                          <p className="text-muted text-xs">Up to 5 photos — JPEG, PNG, WEBP, HEIC</p>
                        </div>
                      ) : (
                        <p className="text-muted text-sm font-cinzel">
                          Add more photos ({5 - referenceImages.length} remaining)
                        </p>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
              {referenceImages.length < 5 && inputMode === "camera" && (
                <motion.div key="camera" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <button
                    onClick={() => setShowCamera(true)}
                    className={`w-full rounded-xl border-2 border-dashed border-cleo-border hover:border-gold/40 transition-all ${referenceImages.length > 0 ? "py-4" : "py-7"}`}
                  >
                    <div className="flex items-center justify-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center text-xl flex-shrink-0">📷</div>
                      {referenceImages.length === 0 ? (
                        <div className="text-left">
                          <p className="text-ink text-sm font-cinzel">Open Camera</p>
                          <p className="text-muted text-xs">Take a live reference photo</p>
                        </div>
                      ) : (
                        <p className="text-muted text-sm font-cinzel">
                          Take another photo ({5 - referenceImages.length} remaining)
                        </p>
                      )}
                    </div>
                  </button>
                </motion.div>
              )}
              {inputMode === "pinterest" && (
                <motion.div key="pinterest" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <PinterestSearch
                    onAdd={handleAddPinterestPin}
                    remainingSlots={5 - referenceImages.length}
                    addedPinIds={addedPinIds}
                  />
                </motion.div>
              )}
              {referenceImages.length >= 5 && inputMode !== "pinterest" && (
                <motion.div key="full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-2">
                  <p className="text-muted text-xs font-mono">Maximum 5 reference images reached</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Generate button */}
          <motion.button
            whileHover={canGenerate ? { scale: 1.02 } : {}}
            whileTap={canGenerate ? { scale: 0.97 } : {}}
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={`w-full py-4 rounded-xl font-cinzel font-bold text-base tracking-[0.08em] uppercase transition-all border ${
              canGenerate
                ? "bg-gold text-bg border-gold hover:bg-gold-light cursor-pointer"
                : "bg-surface-2 text-muted border-cleo-border cursor-not-allowed"
            }`}
          >
            {!tattooDescription.trim()
              ? "Describe your tattoo first"
              : referenceImages.length === 0
              ? "Add a reference image to generate"
              : "✦ Generate Tattoo Designs"}
          </motion.button>
        </motion.div>

        </>} {/* end designMode === "ai" Input Card */}
      </div>

      {/* ── Sticky mobile CTA bar (AI mode only) — mirrors the primary
          action so the user never has to scroll back up. */}
      {designMode === "ai" && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-bg/95 backdrop-blur-md border-t border-cleo-border px-4 pt-3 pb-safe">
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={`w-full py-3.5 rounded-xl font-cinzel font-bold text-sm tracking-[0.08em] uppercase border transition-colors ${
              canGenerate
                ? "bg-gold text-bg border-gold cursor-pointer shadow-[0_0_18px_rgba(201,168,76,0.25)]"
                : "bg-surface-2 text-muted border-cleo-border cursor-not-allowed"
            }`}
          >
            {!tattooDescription.trim()
              ? "Describe your tattoo first"
              : referenceImages.length === 0
              ? "Add a reference image"
              : "✦ Generate Designs"}
          </button>
        </div>
      )}
    </>
  );
}

// ── Body-area picker ──────────────────────────────────────────────
// Optional design-time hint for the AI: lets the customer say where on the
// body the tattoo will live so the model picks an appropriate aspect/flow.
// Empty value = no hint, AI generates as before.

const BODY_AREA_CHIPS = [
  "Forearm",
  "Upper Arm",
  "Shoulder",
  "Wrist",
  "Chest",
  "Back",
  "Ribs",
  "Thigh",
  "Calf",
  "Ankle",
  "Neck",
  "Half Sleeve",
  "Outer Full Sleeve",
  "Half Leg",
  "Outer Full Leg",
  "Full Back",
] as const;

function BodyAreaPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = (BODY_AREA_CHIPS as readonly string[]).includes(value);
  const [customOpen, setCustomOpen] = useState(value !== "" && !isPreset);

  function pickPreset(label: string) {
    if (value === label) {
      onChange("");
    } else {
      onChange(label);
      setCustomOpen(false);
    }
  }

  function toggleCustom() {
    if (customOpen) {
      // Closing — wipe whatever was typed so the AI doesn't pick up a stale hint.
      if (!isPreset) onChange("");
      setCustomOpen(false);
    } else {
      // Opening — clear any preset selection so the input owns the value.
      if (isPreset) onChange("");
      setCustomOpen(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">
          Body placement <span className="text-muted/50 normal-case">(optional — helps the AI compose better)</span>
        </label>
        {value && (
          <button
            type="button"
            onClick={() => { onChange(""); setCustomOpen(false); }}
            className="text-[10px] font-mono text-muted hover:text-gold uppercase tracking-wider cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {BODY_AREA_CHIPS.map((label) => {
          const selected = value === label;
          return (
            <button
              key={label}
              type="button"
              onClick={() => pickPreset(label)}
              aria-pressed={selected}
              className={`px-3 py-1.5 rounded-full text-xs font-mono border transition-colors cursor-pointer ${
                selected
                  ? "bg-gold text-bg border-gold"
                  : "bg-bg text-muted border-cleo-border hover:border-gold/40 hover:text-ink"
              }`}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={toggleCustom}
          aria-pressed={customOpen}
          className={`px-3 py-1.5 rounded-full text-xs font-mono border transition-colors cursor-pointer ${
            customOpen || (!isPreset && value !== "")
              ? "bg-gold text-bg border-gold"
              : "bg-bg text-muted border-cleo-border hover:border-gold/40 hover:text-ink"
          }`}
        >
          Custom…
        </button>
      </div>

      {customOpen && (
        <input
          type="text"
          autoFocus
          value={isPreset ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. inner bicep, between shoulder blades, top of foot…"
          className="bg-bg border border-cleo-border rounded-xl px-4 py-2.5 text-ink text-sm placeholder:text-muted/50 focus:border-gold focus:outline-none transition-colors"
        />
      )}
    </div>
  );
}
