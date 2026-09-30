import type { ModelChoice } from "@/store/app-store";
import { getModelLabel } from "@/lib/model-labels";

// Shared by the Design page (3-way: either model or both, for the first
// batch) and Chat's refinement composer (2-way: one model at a time — a
// refinement batch is small enough that alternating models per slot isn't
// useful the way it is across 5 fresh designs).
const ALL_OPTIONS: { key: ModelChoice; label: string }[] = [
  { key: "nano-banana-pro", label: getModelLabel("nano-banana-pro")! },
  { key: "gpt-image-2-image-to-image", label: getModelLabel("gpt-image-2-image-to-image")! },
  { key: "both", label: "Both" },
];

export default function ModelChoiceSelector({
  value,
  onChange,
  allowBoth = true,
  disabledNote,
}: {
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  allowBoth?: boolean;
  /** When set, shows this note instead of the picker — the choice is locked. */
  disabledNote?: string;
}) {
  const options = allowBoth ? ALL_OPTIONS : ALL_OPTIONS.filter((o) => o.key !== "both");

  return (
    <div className="flex flex-col gap-2 p-3 bg-bg rounded-xl border border-cleo-border">
      <label className="text-xs font-mono tracking-[0.15em] uppercase text-muted">Generation Model</label>
      {disabledNote ? (
        <p className="text-muted text-[11px] leading-snug">{disabledNote}</p>
      ) : (
        <>
          <div className={`grid gap-1.5 ${options.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
            {options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => onChange(opt.key)}
                className={`px-2 py-2 rounded-lg border text-[11px] font-cinzel font-bold uppercase tracking-wide transition-all cursor-pointer ${
                  value === opt.key
                    ? "bg-gold/10 border-gold text-ink"
                    : "bg-surface border-cleo-border text-muted hover:border-gold/40"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {allowBoth && value === "both" && (
            <p className="text-muted text-[10px] leading-snug">
              Images alternate between both models, one after another, so you can compare them side by side.
            </p>
          )}
        </>
      )}
    </div>
  );
}
