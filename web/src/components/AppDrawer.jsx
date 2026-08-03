import { useEffect } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

const taskVisualStyles = `
  html.chefops-task-visual-view main > .mx-auto.max-w-lg {
    max-width: 1180px !important;
  }

  html.chefops-task-visual-view main > .mx-auto.max-w-lg > section {
    min-width: 0;
  }

  html.chefops-task-visual-view main > .mx-auto.max-w-lg > section > div.border-b {
    border-bottom: 0 !important;
    padding-bottom: 0 !important;
  }

  html.chefops-task-visual-view main > .mx-auto.max-w-lg > section > button.rounded-2xl.border {
    border-color: transparent !important;
    background: hsl(var(--muted) / .38) !important;
    box-shadow: none !important;
    transition: background-color .16s ease, transform .16s ease, box-shadow .16s ease;
  }

  html.chefops-task-visual-view main > .mx-auto.max-w-lg > section > button.rounded-2xl.border:hover {
    background: hsl(var(--muted) / .62) !important;
    box-shadow: 0 10px 28px rgb(15 23 42 / .06) !important;
    transform: translateY(-1px);
  }

  html.chefops-task-visual-view main > .mx-auto.max-w-lg > .flex.gap-2.overflow-auto > button {
    height: 2.5rem;
    min-width: 5rem;
    padding: 0 .9rem;
  }

  .chefops-task-workspace-header {
    border-bottom: 0 !important;
  }

  .chefops-task-workspace-header .chefops-task-form-label {
    display: inline-flex;
    min-height: 1.6rem;
    align-items: center;
    border-radius: 999px;
    background: hsl(var(--muted) / .72);
    padding: 0 .65rem;
    font-size: .68rem;
    font-weight: 750;
    letter-spacing: .04em;
    color: hsl(var(--muted-foreground));
    text-transform: uppercase;
  }

  .chefops-task-workspace button:not([aria-label]),
  .chefops-task-workspace input,
  .chefops-task-workspace select {
    min-height: 2.5rem;
  }

  .chefops-task-workspace button:not([aria-label]) {
    border-radius: .75rem !important;
  }

  .chefops-task-workspace textarea,
  .chefops-task-workspace input,
  .chefops-task-workspace select {
    border-radius: .75rem !important;
  }

  .chefops-task-workspace section > div.rounded-2xl.border,
  .chefops-task-workspace section > div.rounded-xl.border {
    border-color: transparent !important;
    background: hsl(var(--muted) / .26) !important;
    box-shadow: none !important;
  }

  .chefops-task-workspace details {
    border: 0 !important;
    background: hsl(var(--muted) / .42) !important;
  }

  @media (min-width: 768px) {
    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace-overlay {
      display: none !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace {
      top: 3.5rem !important;
      right: 0 !important;
      bottom: 0 !important;
      left: 84px !important;
      width: calc(100vw - 84px) !important;
      max-width: none !important;
      height: calc(100dvh - 3.5rem) !important;
      max-height: none !important;
      transform: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: hsl(var(--background)) !important;
      box-shadow: none !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace .chefops-drawer-handle {
      display: none !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace-header {
      padding: 1.7rem clamp(1.5rem, 3vw, 3rem) .75rem !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace > div:last-child > div:first-child {
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: 1rem clamp(1.5rem, 3vw, 3rem) 3rem !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace > div:last-child > div:last-child {
      order: -1;
      display: flex !important;
      justify-content: flex-end;
      gap: .75rem;
      border-top: 0 !important;
      background: transparent !important;
      padding: 0 clamp(1.5rem, 3vw, 3rem) 1rem !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace > div:last-child > div:last-child > button {
      width: auto !important;
      min-width: 8.5rem;
      height: 2.5rem;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace section {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: 1rem;
      row-gap: .8rem;
      padding-top: .65rem;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace section > div:first-child {
      grid-column: 1 / -1;
      margin-bottom: .1rem;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace section > div.rounded-2xl.border {
      height: 100%;
      padding: 1rem !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace section > div.rounded-2xl.border > .mt-3 {
      margin-top: .9rem !important;
    }

    html:not([data-chefops-mode="mobile"]) .chefops-task-workspace section:last-of-type > div:first-child {
      grid-column: 1 / -1;
    }

    html.chefops-task-visual-view main > .mx-auto.max-w-lg > section {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: .8rem;
    }

    html.chefops-task-visual-view main > .mx-auto.max-w-lg > section > div:first-child {
      grid-column: 1 / -1;
    }
  }

  @media (min-width: 1200px) {
    html:not([data-chefops-mode="mobile"]):not([data-chefops-mode="tablet"]) .chefops-task-workspace {
      left: 248px !important;
      width: calc(100vw - 248px) !important;
    }
  }

  html[data-chefops-mode="desktop"] .chefops-task-workspace {
    left: 248px !important;
    width: calc(100vw - 248px) !important;
  }

  html[data-chefops-mode="tablet"] .chefops-task-workspace {
    left: 84px !important;
    width: calc(100vw - 84px) !important;
  }

  html[data-chefops-mode="mobile"] .chefops-task-workspace section,
  .chefops-force-mobile .chefops-task-workspace section {
    display: block !important;
  }

  html[data-chefops-mode="mobile"] .chefops-task-workspace section > *,
  .chefops-force-mobile .chefops-task-workspace section > * {
    margin-top: .5rem;
  }

  @media (max-width: 767px) {
    html.chefops-task-visual-view main > .mx-auto.max-w-lg > section {
      display: block;
    }

    html.chefops-task-visual-view main > .mx-auto.max-w-lg > section > button.rounded-2xl.border {
      margin-top: .55rem;
    }

    .chefops-task-workspace-header .chefops-task-form-label {
      display: none;
    }

    .chefops-task-workspace section {
      display: block;
    }

    .chefops-task-workspace section > * {
      margin-top: .5rem;
    }

    .chefops-task-workspace > div:last-child > div:last-child > button {
      min-height: 2.75rem;
    }
  }
`

export default function AppDrawer({
  open,
  onOpenChange,
  title,
  subtitle = '',
  children,
  heightClass = 'h-[92dvh] max-h-[820px]',
  fullScreen = false,
}) {
  const taskWorkspace = typeof window !== 'undefined' && window.location.pathname === '/tasks'
  const contentClass = fullScreen
    ? 'h-full max-h-none rounded-none border-0'
    : `rounded-t-[24px] border border-b-0 ${heightClass}`

  useEffect(() => {
    if (!taskWorkspace) return undefined
    document.documentElement.classList.add('chefops-task-visual-view')
    return () => document.documentElement.classList.remove('chefops-task-visual-view')
  }, [taskWorkspace])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {taskWorkspace ? <style>{taskVisualStyles}</style> : null}
        <DialogPrimitive.Overlay className={`chefops-drawer-overlay ${taskWorkspace ? 'chefops-task-workspace-overlay' : ''} fixed z-[880] bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0`} />
        <DialogPrimitive.Content
          data-fullscreen={fullScreen ? 'true' : 'false'}
          data-task-visual-workspace={taskWorkspace ? 'true' : 'false'}
          className={`chefops-drawer-content ${taskWorkspace ? 'chefops-task-workspace' : ''} fixed bottom-0 left-1/2 z-[881] flex -translate-x-1/2 flex-col overflow-hidden bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 ${contentClass}`}
        >
          <div className={`chefops-drawer-header ${taskWorkspace ? 'chefops-task-workspace-header' : ''} shrink-0 border-b bg-background px-4 pb-3 pt-[calc(.5rem+env(safe-area-inset-top))]`}>
            {!fullScreen && !taskWorkspace ? <div className="chefops-drawer-handle mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25" /> : null}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {taskWorkspace ? <span className="chefops-task-form-label mb-2">Template form</span> : null}
                <DialogPrimitive.Title className={taskWorkspace ? 'text-xl font-bold leading-tight' : 'text-base font-semibold leading-tight'}>{title}</DialogPrimitive.Title>
                {subtitle && <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">{subtitle}</DialogPrimitive.Description>}
              </div>
              <DialogPrimitive.Close className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Close">
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
