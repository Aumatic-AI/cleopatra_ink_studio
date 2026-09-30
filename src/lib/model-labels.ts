// Human-readable labels for the image-generation models staff can choose
// between (Design page, Chat refinement) or that get auto-compared
// (Placement) — centralized so the label text can't drift between them.
export const MODEL_LABELS: Record<string, string> = {
  "nano-banana-pro": "Nano Banana Pro",
  "gpt-image-2-image-to-image": "GPT Image to Image",
};

export function getModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  return MODEL_LABELS[model] ?? model;
}
