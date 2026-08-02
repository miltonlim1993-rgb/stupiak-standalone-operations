import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function MobileSheet({
  open,
  onClose,
  title,
  description,
  children,
  closeDisabled = false,
  compact = true,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !closeDisabled) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.touchAction = previousTouchAction;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, closeDisabled]);

  if (!open) return null;

  return createPortal(
    <div className="chefops-mobile-sheet fixed z-[900]" data-no-swipe-back>
      <button
        type="button"
        aria-label="Close drawer"
        className="chefops-mobile-sheet-overlay absolute inset-0 z-0 bg-black/50 backdrop-blur-[1px]"
        onClick={() => !closeDisabled && onClose?.()}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-compact={compact ? "true" : "false"}
        className="chefops-mobile-sheet-panel absolute bottom-0 left-1/2 z-[901] flex -translate-x-1/2 flex-col overflow-hidden rounded-t-[24px] border border-border bg-background shadow-2xl"
      >
        <div className="chefops-mobile-sheet-handle flex shrink-0 justify-center pb-0.5 pt-2">
          <span className="h-1 w-10 rounded-full bg-muted-foreground/25" />
        </div>

        <header className="chefops-mobile-sheet-header flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 pb-3 pt-2">
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-5">{title}</h2>
            {description ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => !closeDisabled && onClose?.()}
            disabled={closeDisabled}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground transition hover:bg-muted disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          className="chefops-mobile-sheet-body min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))]"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
