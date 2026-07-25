import { toast as sonnerToast } from "sonner"

function toast({ title, description, variant, ...options } = {}) {
  const message = title || description || "Notification"
  const config = {
    description: title ? description : undefined,
    ...options,
  }

  if (variant === "destructive") {
    return sonnerToast.error(message, config)
  }

  return sonnerToast(message, config)
}

function useToast() {
  return {
    toast,
    dismiss: sonnerToast.dismiss,
    toasts: [],
  }
}

export { toast, useToast }
