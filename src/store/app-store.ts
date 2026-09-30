import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";
import { createSupabaseBrowserClient } from "@/lib/supabase-client";

// Throttled localStorage — batches rapid writes (e.g. during streaming generation)
// into one write per 400ms instead of one per state update. Reads are always instant.
function makeThrottledStorage(delay = 400): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const base = typeof window !== "undefined" ? localStorage : null;
  return {
    getItem: (key) => base?.getItem(key) ?? null,
    removeItem: (key) => base?.removeItem(key),
    setItem: (key, value) => {
      if (!base) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { base.setItem(key, value); timer = null; }, delay);
    },
  };
}

// SSR browser client — picks up staff session from cookies so RLS works correctly
const supabase = createSupabaseBrowserClient();

export interface DesignVariant {
  id: string;
  dbId?: string; // Supabase tattoo_designs.id once persisted
  gradient: string;
  patternType: "mandala" | "geometric" | "tribal" | "floral" | "dark" | "minimal" | "japanese" | "biomech";
  styleName: string;
  imageUrl?: string; // real generated image from KEI API
  model?: string; // which image-generation model produced it — for the model tag in Chat
}

export type ModelChoice = "nano-banana-pro" | "gpt-image-2-image-to-image" | "both";

// One placement generation attempt now produces one result per model (see
// AGENTS.md) — this is one of those results, tagged with which model made it.
export interface PlacementResult {
  dbId: string;
  url: string;
  model: string | null;
}

interface AppState {
  // Staff context
  designerId: string | null;  // staff.id of the logged-in designer

  // Customer info
  sessionId: string;
  customerId: string | null;  // users.id from Supabase
  customerName: string;
  customerPhone: string;

  // Design step
  tattooStyle: string;
  tattooDescription: string;
  targetBodyArea: string;             // optional body-part hint for design generation
  referenceImages: string[];
  selectedColors: string[];           // hex codes from TATTOO_COLORS — empty = black & grey
  generatedDesigns: DesignVariant[];
  selectedDesigns: DesignVariant[];   // multi-select for refinement
  selectedDesign: DesignVariant | null; // final approved single design
  refinementText: string;
  isGenerating: boolean;
  iterationCount: number;
  
  // Text Tattoo Modal state (persisted across reloads if active)
  textTattooFont: string | null;
  isTextTattoo: boolean;

  // Rework (cover-up/extend) — a session is either "ai_design" or "rework"
  flowType: "ai_design" | "rework" | "direct";
  reworkMode: "cover" | "extend";
  reworkPhoto: string | null; // the existing-tattoo photo to cover/extend (blob: until generation uploads it)
  // Set right before navigating Design -> Chat; the chat screen consumes it
  // to know it should kick off the first generation itself, then clears it.
  pendingGeneration: boolean;
  // The model choice picked on the Design page for the very first batch —
  // Chat reads this once for that first generation, then uses its own local
  // (two-option, no "both") selector for every refinement after that.
  initialGenerationModel: ModelChoice;

  // Placement step
  placementText: string;
  bodyPhoto: string | null;
  // One result per model from the most recent generation attempt (see
  // AGENTS.md) — not a single composite anymore.
  placementResults: PlacementResult[];
  isGeneratingPlacement: boolean;

  // The session row's actual status (from the DB, via hydrateFromSession) —
  // lets a reloaded page tell "already finalized" from "still in progress"
  // without relying on any local-only flag that resets on reload.
  sessionStatus: "active" | "completed" | "abandoned";

  // Hydration status — set true after first hydrate attempt for current session
  hydratedSessionId: string | null;

  // Actions
  setDesignerId: (id: string | null) => void;
  startSession: (name: string, phone: string) => Promise<{ sessionId: string; userId: string | null; isNew: boolean }>;
  startSessionForUser: (userId: string, name: string, phone: string) => Promise<string>;
  setTattooStyle: (style: string) => void;
  setTattooDescription: (text: string) => void;
  setTargetBodyArea: (text: string) => void;
  setFlowType: (type: "ai_design" | "rework" | "direct") => void;
  setReworkMode: (mode: "cover" | "extend") => void;
  setReworkPhoto: (url: string | null) => void;
  setPendingGeneration: (pending: boolean) => void;
  setInitialGenerationModel: (choice: ModelChoice) => void;
  setIsTextTattoo: (value: boolean) => void;
  addReferenceImage: (url: string) => void;
  removeReferenceImage: (index: number) => void;
  replaceReferenceImage: (oldUrl: string, newUrl: string) => void;
  toggleColor: (hex: string) => void;
  clearColors: () => void;
  generateDesigns: () => void;
  addGeneratedDesign: (design: DesignVariant) => void;
  finishGenerating: (designs?: DesignVariant[]) => void;
  toggleDesignSelection: (design: DesignVariant) => void;
  clearDesignSelection: () => void;
  selectDesign: (design: DesignVariant) => void;
  setRefinementText: (text: string) => void;
  setTextTattooDetails: (font: string | null) => void;
  setPlacementText: (text: string) => void;
  setBodyPhoto: (url: string | null) => void;
  generatePlacement: () => void;
  finishPlacement: (results: PlacementResult[]) => void;
  // Supabase persistence
  persistDesigns: (designs: DesignVariant[], meta?: { iteration?: number; parentDesignIds?: string[]; userInstruction?: string }) => Promise<DesignVariant[]>;
  persistPlacement: (data: { placementText?: string; bodyPhotoUrl?: string; compositeUrl?: string; model?: string; attemptId?: string }) => Promise<string | null>;
  finalizeSession: (designId: string, placementId: string) => Promise<void>;
  finalizeReworkSession: (designId: string) => Promise<void>;
  // Restore state from Supabase for the given session (used after reload)
  hydrateFromSession: (sessionId: string) => Promise<void>;
  reset: () => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

const defaultState = {
  designerId: null as string | null,
  sessionId: "",
  customerId: null as string | null,
  customerName: "",
  customerPhone: "",
  tattooStyle: "",
  tattooDescription: "",
  targetBodyArea: "",
  textTattooFont: null,
  isTextTattoo: false,
  flowType: "ai_design" as "ai_design" | "rework" | "direct",
  reworkMode: "cover" as "cover" | "extend",
  reworkPhoto: null as string | null,
  pendingGeneration: false,
  initialGenerationModel: "both" as ModelChoice,
  referenceImages: [],
  selectedColors: [] as string[],
  generatedDesigns: [],
  selectedDesigns: [],
  selectedDesign: null,
  refinementText: "",
  isGenerating: false,
  iterationCount: 0,
  placementText: "",
  bodyPhoto: null,
  placementResults: [] as PlacementResult[],
  isGeneratingPlacement: false,
  sessionStatus: "active" as "active" | "completed" | "abandoned",
  hydratedSessionId: null as string | null,
};

// Resets all design/placement state when starting a fresh session.
// Applied in startSession + startSessionForUser to prevent old session data
// from bleeding into a new session via localStorage persistence.
const freshSessionDesignState = {
  tattooStyle: "",
  tattooDescription: "",
  targetBodyArea: "",
  textTattooFont: null,
  isTextTattoo: false,
  flowType: "ai_design" as "ai_design" | "rework" | "direct",
  reworkMode: "cover" as "cover" | "extend",
  reworkPhoto: null as string | null,
  pendingGeneration: false,
  initialGenerationModel: "both" as ModelChoice,
  referenceImages: [] as string[],
  selectedColors: [] as string[],
  generatedDesigns: [],
  selectedDesigns: [],
  selectedDesign: null,
  refinementText: "",
  isGenerating: false,
  iterationCount: 0,
  placementText: "",
  bodyPhoto: null,
  placementResults: [] as PlacementResult[],
  isGeneratingPlacement: false,
  sessionStatus: "active" as "active" | "completed" | "abandoned",
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...defaultState,

  setDesignerId: (id) => set({ designerId: id }),

  startSession: async (name, phone) => {
    // Check if user already exists
    const { data: existing } = await supabase
      .from("users")
      .select("id, first_name")
      .eq("phone", phone)
      .maybeSingle();

    if (existing) {
      // Existing user — do not create a session, let the caller redirect to dashboard
      set({ customerId: existing.id, customerName: existing.first_name, customerPhone: phone });
      return { sessionId: "", userId: existing.id, isNew: false };
    }

    // New user — insert and start a session
    const id = generateId();
    const { data: user } = await supabase
      .from("users")
      .insert({ first_name: name, phone })
      .select("id")
      .single();

    const { designerId } = get();
    await supabase.from("sessions").insert({ id, user_id: user?.id ?? null, status: "active", designer_id: designerId ?? null });
    set({
      ...freshSessionDesignState,
      sessionId: id, customerId: user?.id ?? null,
      customerName: name, customerPhone: phone, hydratedSessionId: id,
    });
    return { sessionId: id, userId: user?.id ?? null, isNew: true };
  },

  startSessionForUser: async (userId, name, phone) => {
    const id = generateId();
    const { designerId } = get();
    await supabase.from("sessions").insert({ id, user_id: userId, status: "active", designer_id: designerId ?? null });
    set({
      ...freshSessionDesignState,
      sessionId: id, customerId: userId,
      customerName: name, customerPhone: phone, hydratedSessionId: id,
    });
    return id;
  },

  setTattooDescription: (text) => set({ tattooDescription: text }),

  setTargetBodyArea: (text) => set({ targetBodyArea: text }),

  addReferenceImage: (url) =>
    set((s) => ({
      referenceImages: s.referenceImages.length < 5 ? [...s.referenceImages, url] : s.referenceImages,
    })),

  removeReferenceImage: (index) =>
    set((s) => ({ referenceImages: s.referenceImages.filter((_, i) => i !== index) })),

  replaceReferenceImage: (oldUrl, newUrl) =>
    set((s) => ({ referenceImages: s.referenceImages.map((u) => (u === oldUrl ? newUrl : u)) })),

  toggleColor: (hex) =>
    set((s) => {
      const HEX = hex.toUpperCase();
      const current = s.selectedColors.map((c) => c.toUpperCase());
      return current.includes(HEX)
        ? { selectedColors: s.selectedColors.filter((c) => c.toUpperCase() !== HEX) }
        : { selectedColors: [...s.selectedColors, HEX] };
    }),

  clearColors: () => set({ selectedColors: [] }),

  setTattooStyle: (style) => set({ tattooStyle: style }),

  setFlowType: (type) => set({ flowType: type }),

  setReworkMode: (mode) => set({ reworkMode: mode }),

  setReworkPhoto: (url) => set({ reworkPhoto: url }),

  setPendingGeneration: (pending) => set({ pendingGeneration: pending }),

  setInitialGenerationModel: (choice) => set({ initialGenerationModel: choice }),

  setIsTextTattoo: (value) => set({ isTextTattoo: value }),

  generateDesigns: () =>
    set((s) => ({
      isGenerating: true,
      iterationCount: s.iterationCount + 1,
      generatedDesigns: [],
      selectedDesigns: [],
    })),

  addGeneratedDesign: (design) =>
    set((s) => ({ generatedDesigns: [...s.generatedDesigns, design] })),

  finishGenerating: (designs?) =>
    set((s) => ({
      isGenerating: false,
      generatedDesigns: designs && designs.length > 0 ? designs : s.generatedDesigns,
      selectedDesigns: [],
      refinementText: "",
    })),

  toggleDesignSelection: (design) =>
    set((s) => {
      const alreadySelected = s.selectedDesigns.some((d) => d.id === design.id);
      if (alreadySelected) {
        return { selectedDesigns: s.selectedDesigns.filter((d) => d.id !== design.id) };
      }
      if (s.selectedDesigns.length >= 4) return {};
      return { selectedDesigns: [...s.selectedDesigns, design] };
    }),

  clearDesignSelection: () => set({ selectedDesigns: [] }),

  selectDesign: (design) => set({ selectedDesign: design }),

  setRefinementText: (text) => set({ refinementText: text }),

  setTextTattooDetails: (font) => set({ textTattooFont: font }),

  setPlacementText: (text) => set({ placementText: text }),

  setBodyPhoto: (url) => set({ bodyPhoto: url }),

  generatePlacement: () => set({ isGeneratingPlacement: true, placementResults: [] }),

  finishPlacement: (results) =>
    set({ isGeneratingPlacement: false, placementResults: results }),

  persistDesigns: async (designs, meta) => {
    const { sessionId, tattooStyle, tattooDescription, targetBodyArea, iterationCount, flowType } = get();
    if (!sessionId) return designs;

    // Keep session row in sync with latest style/description/body-area hint.
    // Rework sessions don't use target_body_area (the source photo already
    // shows the placement), so leave it untouched for that flow.
    await supabase
      .from("sessions")
      .update({
        tattoo_style: tattooStyle,
        tattoo_description: tattooDescription,
        ...(flowType === "ai_design" ? { target_body_area: targetBodyArea || null } : {}),
      })
      .eq("id", sessionId);

    const persistable = designs.filter((d) => d.imageUrl);
    if (persistable.length === 0) return designs;

    const { data, error } = await supabase
      .from("tattoo_designs")
      .insert(
        persistable.map((d) => ({
          session_id: sessionId,
          image_url: d.imageUrl!,
          style_name: d.styleName,
          // Rework has no pattern-type concept (it's an edit of an existing
          // tattoo, not a style-based generation) — "mandala" is only ever a
          // required placeholder value on the caller's side for this flow.
          pattern_type: flowType === "rework" ? null : d.patternType,
          iteration: meta?.iteration ?? iterationCount,
          parent_design_ids: meta?.parentDesignIds ?? [],
          user_instruction: meta?.userInstruction ?? null,
          generation_model: d.model ?? null,
        }))
      )
      .select("id, image_url");

    if (error || !data) {
      // Never silently pretend this succeeded — a caller that gets `designs`
      // back unchanged (no dbId) has no way to tell the DB write actually
      // failed. Both callers (design/page.tsx's Upload Existing, chat's
      // watchJob) already catch and surface errors; before this they'd
      // catch nothing and carry on as if the design were really persisted —
      // including using a fake local id anywhere a real tattoo_designs.id
      // was expected (e.g. finalize_session).
      const detail = error
        ? [error.message, error.details, error.hint].filter(Boolean).join(" — ")
        : "insert returned no rows";
      console.error("persistDesigns failed:", detail, error);
      throw new Error(`Couldn't save the design: ${detail}`);
    }

    // Map db rows back onto local design objects by image_url
    return designs.map((d) => {
      const match = data.find((row: { id: string; image_url: string }) => row.image_url === d.imageUrl);
      return match ? { ...d, dbId: match.id } : d;
    });
  },

  persistPlacement: async ({ placementText, bodyPhotoUrl, compositeUrl, model, attemptId }) => {
    const { sessionId } = get();
    if (!sessionId) return null;
    const { data } = await supabase
      .from("placements")
      .insert({
        session_id: sessionId,
        placement_text: placementText ?? null,
        body_photo_url: bodyPhotoUrl ?? null,
        final_composite_url: compositeUrl ?? null,
        generation_model: model ?? null,
        attempt_id: attemptId ?? null,
      })
      .select("id")
      .single();
    return data?.id ?? null;
  },

  finalizeSession: async (designId, placementId) => {
    const { sessionId } = get();
    if (!sessionId) return;

    // Fast path: the SQL RPC does mark+prune+complete+analytics atomically.
    const { error: rpcError } = await supabase.rpc("finalize_session", {
      p_session_id: sessionId,
      p_design_id: designId,
      p_placement_id: placementId,
    });
    if (!rpcError) { set({ sessionStatus: "completed" }); return; }

    // RPC failed (most often: live DB still has the pre-hotfix function, so
    // a user_preferences NOT NULL violation aborts the whole transaction).
    // The critical path doesn't need the RPC — fall back to plain table ops.
    // user_preferences is analytics-only; we deliberately skip it here.
    console.warn("finalize_session RPC failed — falling back to manual sequence:", rpcError);

    // Unset any previous finalized choice first — only one design/placement
    // can be finalized at a time, but nothing is ever deleted.
    await Promise.all([
      supabase.from("tattoo_designs").update({ is_finalized: false }).eq("session_id", sessionId).eq("is_finalized", true),
      supabase.from("placements").update({ is_finalized: false }).eq("session_id", sessionId).eq("is_finalized", true),
    ]);

    const [designUpdate, placementUpdate] = await Promise.all([
      supabase.from("tattoo_designs").update({ is_finalized: true }).eq("id", designId),
      supabase.from("placements").update({ is_finalized: true }).eq("id", placementId),
    ]);
    if (designUpdate.error) throw new Error(`Finalize fallback: design update failed — ${designUpdate.error.message}`);
    if (placementUpdate.error) throw new Error(`Finalize fallback: placement update failed — ${placementUpdate.error.message}`);

    const { error: sessionError } = await supabase
      .from("sessions")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", sessionId);
    if (sessionError) throw new Error(`Finalize fallback: session update failed — ${sessionError.message}`);
    set({ sessionStatus: "completed" });
  },

  finalizeReworkSession: async (designId) => {
    const { sessionId } = get();
    if (!sessionId) return;

    const { error: rpcError } = await supabase.rpc("finalize_rework_session", {
      p_session_id: sessionId,
      p_design_id: designId,
    });
    if (!rpcError) { set({ sessionStatus: "completed" }); return; }

    console.warn("finalize_rework_session RPC failed — falling back to manual sequence:", rpcError);

    // Unset any previous finalized choice first — only one design can be
    // finalized at a time, but nothing is ever deleted.
    await supabase.from("tattoo_designs").update({ is_finalized: false }).eq("session_id", sessionId).eq("is_finalized", true);

    const { error: designError } = await supabase
      .from("tattoo_designs").update({ is_finalized: true }).eq("id", designId);
    if (designError) throw new Error(`Finalize fallback: design update failed — ${designError.message}`);

    const { error: sessionError } = await supabase
      .from("sessions")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", sessionId);
    if (sessionError) throw new Error(`Finalize fallback: session update failed — ${sessionError.message}`);
    set({ sessionStatus: "completed" });
  },

  hydrateFromSession: async (sessionId) => {
    if (!sessionId) return;
    const { hydratedSessionId, sessionId: currentSessionId, generatedDesigns } = get();

    // Already hydrated this session and we still have its designs in memory — skip.
    if (hydratedSessionId === sessionId && currentSessionId === sessionId && generatedDesigns.length > 0) {
      return;
    }

    // Pull session + designs + placements + user in one round-trip
    const { data: session, error } = await supabase
      .from("sessions")
      .select(`
        id,
        user_id,
        tattoo_style,
        tattoo_description,
        target_body_area,
        flow_type,
        rework_mode,
        status,
        users ( first_name, phone ),
        tattoo_designs ( id, image_url, style_name, pattern_type, iteration, is_finalized, generation_model ),
        placements ( id, placement_text, body_photo_url, final_composite_url, is_finalized, created_at, generation_model, attempt_id )
      `)
      .eq("id", sessionId)
      .maybeSingle();

    if (error || !session) {
      console.warn("hydrateFromSession: no session found", { sessionId, error });
      set({ hydratedSessionId: sessionId });
      return;
    }

    const user = Array.isArray(session.users) ? session.users[0] : session.users;
    const designs = (session.tattoo_designs ?? []) as Array<{
      id: string;
      image_url: string;
      style_name: string | null;
      pattern_type: string | null;
      iteration: number;
      is_finalized: boolean;
      generation_model: string | null;
    }>;

    // Use the latest iteration's designs — older iterations were superseded
    const latestIteration = designs.reduce((max, d) => Math.max(max, d.iteration ?? 1), 0);
    const latestDesigns = designs
      .filter((d) => (d.iteration ?? 1) === latestIteration)
      .map((d, i) => ({
        id: `db-${d.id}`,
        dbId: d.id,
        gradient: defaultGradients[i % defaultGradients.length],
        patternType: (d.pattern_type as DesignVariant["patternType"]) ?? "mandala",
        styleName: d.style_name ?? `Variation ${i + 1}`,
        imageUrl: d.image_url,
        model: d.generation_model ?? undefined,
      }));

    const finalizedDesign = latestDesigns.find((d) =>
      designs.find((row) => row.id === d.dbId && row.is_finalized)
    );

    const placements = (session.placements ?? []) as Array<{
      id: string;
      placement_text: string | null;
      body_photo_url: string | null;
      final_composite_url: string | null;
      is_finalized: boolean;
      created_at: string;
      generation_model: string | null;
      attempt_id: string | null;
    }>;
    // Newest first — if finalize_session hasn't run yet, multiple in-flight
    // placement rows can exist; the user expects the latest preview restored.
    const sortedPlacements = [...placements].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const finalizedPlacement = sortedPlacements.find((p) => p.is_finalized);
    const latestWithComposite = sortedPlacements.find((p) => p.final_composite_url) ?? sortedPlacements[0];

    // Once finalized, that one choice is final — restore just it, not its
    // sibling from the same attempt. Otherwise restore every row from the
    // most recent attempt (its whole model comparison), grouped by
    // attempt_id — falling back to just the one row for attempts from
    // before that column existed.
    const placementResults: PlacementResult[] = finalizedPlacement
      ? [{ dbId: finalizedPlacement.id, url: finalizedPlacement.final_composite_url ?? "", model: finalizedPlacement.generation_model }]
      : !latestWithComposite
      ? []
      : latestWithComposite.attempt_id
      ? sortedPlacements
          .filter((p) => p.attempt_id === latestWithComposite.attempt_id && p.final_composite_url)
          .map((p) => ({ dbId: p.id, url: p.final_composite_url!, model: p.generation_model }))
      : latestWithComposite.final_composite_url
      ? [{ dbId: latestWithComposite.id, url: latestWithComposite.final_composite_url, model: latestWithComposite.generation_model }]
      : [];
    const placementTextSource = finalizedPlacement ?? latestWithComposite;

    set({
      sessionId,
      customerId: session.user_id ?? null,
      customerName: user?.first_name ?? get().customerName,
      customerPhone: user?.phone ?? get().customerPhone,
      tattooStyle: session.tattoo_style ?? "",
      tattooDescription: session.tattoo_description ?? "",
      targetBodyArea: session.target_body_area ?? "",
      flowType: (session.flow_type as "ai_design" | "rework" | "direct" | null) ?? "ai_design",
      reworkMode: (session.rework_mode as "cover" | "extend" | null) ?? "cover",
      generatedDesigns: latestDesigns,
      selectedDesign: finalizedDesign ?? get().selectedDesign ?? latestDesigns[0] ?? null,
      iterationCount: latestIteration || 0,
      placementText: placementTextSource?.placement_text ?? "",
      placementResults,
      sessionStatus: (session.status as "active" | "completed" | "abandoned") ?? "active",
      hydratedSessionId: sessionId,
    });
  },

      reset: () => set(defaultState),
    }),
    {
      name: "cleopatra-app-store",
      storage: createJSONStorage(() => makeThrottledStorage(400)),
      // Persist only what's safe to restore. Blob URLs (referenceImages, bodyPhoto)
      // become invalid after reload; transient flags shouldn't survive.
      partialize: (state) => ({
        designerId: state.designerId,
        sessionId: state.sessionId,
        customerId: state.customerId,
        customerName: state.customerName,
        customerPhone: state.customerPhone,
        tattooStyle: state.tattooStyle,
        tattooDescription: state.tattooDescription,
        targetBodyArea: state.targetBodyArea,
        flowType: state.flowType,
        reworkMode: state.reworkMode,
        selectedColors: state.selectedColors,
        generatedDesigns: state.generatedDesigns,
        selectedDesigns: state.selectedDesigns,
        selectedDesign: state.selectedDesign,
        refinementText: state.refinementText,
        iterationCount: state.iterationCount,
        placementText: state.placementText,
        placementResults: state.placementResults,
        initialGenerationModel: state.initialGenerationModel,
        sessionStatus: state.sessionStatus,
        hydratedSessionId: state.hydratedSessionId,
      }),
      version: 1,
    }
  )
);

const defaultGradients = [
  "radial-gradient(ellipse at 50% 40%, #4a0080 0%, #1a0030 40%, #0d0010 100%)",
  "radial-gradient(ellipse at 40% 35%, #8b0000 0%, #3a0000 40%, #0a0000 100%)",
  "radial-gradient(ellipse at 45% 45%, #1a2a4a 0%, #0a1a2a 50%, #000a0d 100%)",
  "radial-gradient(ellipse at 45% 45%, #c9a84c 0%, #6b4800 50%, #1a1000 100%)",
  "radial-gradient(ellipse at 55% 40%, #1a3a1a 0%, #0a1a08 50%, #000500 100%)",
];

