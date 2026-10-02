import { useSyncExternalStore } from "react";

// Light, dark, or whatever the computer uses: chosen in the account menu, remembered per browser, and
// set on the page as data-theme, which styles.css follows. index.html applies the remembered one
// before the page draws, so it never flashes the other; the server's sign-in pages read it too.

export type Theme = "system" | "light" | "dark";

const KEY = "yjsp.theme";
const listeners = new Set<() => void>();

function stored(): Theme {
    try {
        const value = window.localStorage.getItem(KEY);
        return value === "light" || value === "dark" ? value : "system";
    } catch {
        return "system"; // storage blocked: the choice lasts until the page reloads
    }
}

let current = stored();

export function setTheme(theme: Theme): void {
    current = theme;
    try {
        if (theme === "system") {
            window.localStorage.removeItem(KEY);
        } else {
            window.localStorage.setItem(KEY, theme);
        }
    } catch {
        // see stored()
    }
    if (theme === "system") {
        delete document.documentElement.dataset.theme;
    } else {
        document.documentElement.dataset.theme = theme;
    }
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useTheme(): Theme {
    return useSyncExternalStore(subscribe, () => current);
}
