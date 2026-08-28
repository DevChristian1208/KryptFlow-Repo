"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";

type ToastType = "error" | "success" | "info";
type Toast = { id: number; message: string; type: ToastType };

type ToastContextType = {
  showToast: (message: string, type?: ToastType) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const ICONS: Record<ToastType, typeof AlertCircle> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

const COLORS: Record<ToastType, string> = {
  error: "var(--danger)",
  success: "var(--success)",
  info: "var(--accent)",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "error") => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 items-center pointer-events-none px-4">
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              role="alert"
              onClick={() => dismiss(t.id)}
              className="toast-in card-surface pointer-events-auto flex items-start gap-3 px-4 py-3 max-w-sm cursor-pointer"
              style={{ borderColor: COLORS[t.type] }}
            >
              <Icon
                size={18}
                className="shrink-0 mt-0.5"
                style={{ color: COLORS[t.type] }}
              />
              <span className="text-sm text-[var(--foreground)]">{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
