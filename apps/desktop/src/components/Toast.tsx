import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Transient confirmations — "Key saved", "Backup written".
 *
 * These replaced a `notice` string threaded through every screen, which meant
 * each screen had to remember to clear it and none of them agreed on when.
 * Errors still render inline as a {@link Banner}: an error the user must act on
 * should not evaporate after four seconds.
 */
export interface Toast {
  id: number;
  message: string;
  tone: "default" | "error";
}

interface ToastApi {
  show(message: string, tone?: Toast["tone"]): void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export const useToast = (): ToastApi => useContext(ToastContext);

const DISMISS_AFTER_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: Toast["tone"] = "default") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      DISMISS_AFTER_MS,
    );
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={toast.tone === "error" ? "toast toast-error" : "toast"}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
