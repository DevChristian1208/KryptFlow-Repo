"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";

type Theme = "light" | "dark";
type ThemeContextType = {
  /** Aktuell wirksames Theme (System-Einstellung, falls kein Override gesetzt ist) */
  theme: Theme;
  /** true, wenn der Nutzer die System-Einstellung manuell überschrieben hat */
  isOverridden: boolean;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function systemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [isOverridden, setIsOverridden] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      setIsOverridden(true);
    } else {
      setTheme(systemPrefersDark() ? "dark" : "light");
    }
  }, []);

  useEffect(() => {
    if (isOverridden) {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme, isOverridden]);

  // Solange keine explizite Wahl getroffen wurde, der System-Einstellung folgen
  useEffect(() => {
    if (isOverridden) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [isOverridden]);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      setIsOverridden(true);
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, isOverridden, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
