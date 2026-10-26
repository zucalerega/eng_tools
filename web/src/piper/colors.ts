import { useSyncExternalStore } from "react";
import { useTheme } from "../theme";
import type { Drawing } from "./drawing";

// The colors a drawing's drawn in: ink on paper, light or dark as the site is (exports are always light, as on
// paper), and its valves' states, its own if it chose them.

export interface Palette {
    ink: string;
    paper: string;
    muted: string;
    grid: string;
    gridMajor: string;
    select: string; // what's selected, and where a line will go
    guide: string; // a snap's guide
    model: string; // a simulation's values: its gold, dark enough to read as words on the paper
    no: string; // normally open, and open in a test
    nc: string; // normally closed, and closed
    fip: string; // fails in place: a double-acting valve, which stays as it was when its air or power goes
    other: string; // a valve's state in a test that's neither (a fault)
}

export const LIGHT: Palette = {
    ink: "#1b2433",
    paper: "#ffffff",
    muted: "#6b7686",
    grid: "#edf0f5",
    gridMajor: "#dde2ea",
    select: "#1d6fe0",
    guide: "#e0a500",
    model: "#9c6900",
    no: "#2e9e4f",
    nc: "#d64541",
    fip: "#5b7a99",
    other: "#e0a500",
};

export const DARK: Palette = {
    ink: "#e5ebf4",
    paper: "#0e1522",
    muted: "#95a1b5",
    grid: "#141d2c",
    gridMajor: "#1d2839",
    select: "#7aa7ee",
    guide: "#e0a500",
    model: "#e0a500",
    no: "#3fbf6f",
    nc: "#f0605a",
    fip: "#86a3c2",
    other: "#e0a500",
};

/** A palette with a drawing's own state colors, where it chose them. */
export const withStates = (palette: Palette, drawing: Drawing): Palette => ({
    ...palette,
    no: drawing.style.no || palette.no,
    nc: drawing.style.nc || palette.nc,
    fip: drawing.style.fip || palette.fip,
});

/** The color a valve's normal state fills it with (NO, NC, FIP), or null if it has none set. */
export function normalFill(palette: Palette, normal: string | undefined): string | null {
    return normal === "NO" ? palette.no : normal === "NC" ? palette.nc : normal === "FIP" ? palette.fip : null;
}

const dark =
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function subscribe(listener: () => void): () => void {
    dark?.addEventListener("change", listener);
    return () => dark?.removeEventListener("change", listener);
}

/** The palette for the site's theme now: the account menu's choice, or the computer's. */
export function usePalette(): Palette {
    const theme = useTheme();
    const computerDark = useSyncExternalStore(subscribe, () => dark?.matches ?? false);
    return theme === "dark" || (theme === "system" && computerDark) ? DARK : LIGHT;
}
