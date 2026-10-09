export type ThemeMode = "system" | "light" | "dark";

export interface Theme {
  mode: ThemeMode;
  accent: string;
}

export const ACCENTS = [
  { id: "default", label: "Mono", swatch: "#171717" },
  { id: "ocean", label: "Ocean", swatch: "#2563eb" },
  { id: "forest", label: "Forest", swatch: "#16a34a" },
  { id: "sunset", label: "Sunset", swatch: "#ea580c" },
  { id: "grape", label: "Grape", swatch: "#9333ea" },
  { id: "rose", label: "Rose", swatch: "#e11d48" },
] as const;

export const MODES: ThemeMode[] = ["system", "light", "dark"];

const KEY = "rc-theme";

export function loadTheme(): Theme {
  if (typeof window === "undefined") return { mode: "system", accent: "default" };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { mode: "system", accent: "default" };
    const parsed = JSON.parse(raw);
    return {
      mode: MODES.includes(parsed.mode) ? parsed.mode : "system",
      accent:
        typeof parsed.accent === "string" ? parsed.accent : "default",
    };
  } catch {
    return { mode: "system", accent: "default" };
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const dark =
    theme.mode === "dark" ||
    (theme.mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.dataset.accent = theme.accent;
  try {
    localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    // private mode — theme just won't persist
  }
}

/**
 * Inline <head> script (see layout.tsx) so the theme applies before
 * first paint — no flash of the wrong mode/accent.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=JSON.parse(localStorage.getItem("rc-theme")||"{}");var m=t.mode||"system";var a=t.accent||"default";var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.dataset.accent=a;}catch(e){}})();`;
