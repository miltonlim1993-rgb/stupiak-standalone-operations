import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

export default function AppDrawer({
  open,
  onOpenChange,
  title,
  subtitle = '',
  children,
  heightClass = 'h-[92dvh] max-h-[820px]',
  fullScreen = false,
}) {
  const contentClass = fullScreen
    ? 'h-full max-h-none rounded-none border-0'
    : `rounded-t-[24px] border border-b-0 ${heightClass}`

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="chefops-drawer-overlay fixed z-[880] bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          data-fullscreen={fullScreen ? 'true' : 'false'}
          className={`chefops-drawer-content fixed bottom-0 left-1/2 z-[881] flex -translate-x-1/2 flex-col overflow-hidden bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 ${contentClass}`}
        >
          <div className="chefops-drawer-header shrink-0 border-b bg-background px-4 pb-3 pt-[calc(.5rem+env(safe-area-inset-top))]">
            {!fullScreen ? <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25" /> : null}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogPrimitive.Title className="text-base font-semibold leading-tight">{title}</DialogPrimitive.Title>
                {subtitle && <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">{subtitle}</DialogPrimitive.Description>}
              </div>
              <DialogPrimitive.Close className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Close">
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
