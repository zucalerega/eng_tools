import { useEffect, useState } from "react";
import { useTheme } from "../theme";
import type { PlotColors } from "./Plot";

// The plots' colors come from the page's (yorg.css), so they follow light and dark like everything else.

const FALLBACK: PlotColors = {
    plot: "#ffffff",
    grid: "#e6eaf0",
    frame: "#cdd5e1",
    text: "#5b677a",
    cursor: "#0f1b2d",
    selection: "rgb(29 77 148 / 14%)",
    marker: "#bc4c00",
    event: "#8e5bd6",
    t0: "#d64541",
    font: "system-ui, sans-serif",
};

function read(): PlotColors {
    if (typeof window === "undefined" || typeof getComputedStyle === "undefined") {
        return FALLBACK;
    }
    const style = getComputedStyle(document.documentElement);
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
        plot: value("--plot-bg", FALLBACK.plot),
        grid: value("--plot-grid", FALLBACK.grid),
        frame: value("--plot-frame", FALLBACK.frame),
        text: value("--plot-text", FALLBACK.text),
        cursor: value("--plot-cursor", FALLBACK.cursor),
        selection: value("--plot-selection", FALLBACK.selection),
        marker: value("--plot-marker", FALLBACK.marker),
        event: value("--plot-event", FALLBACK.event),
        t0: value("--plot-t0", FALLBACK.t0),
        font: getComputedStyle(document.body).fontFamily || FALLBACK.font,
    };
}

/** The plots' colors, again whenever the theme (or the computer's light or dark) changes. */
export function usePlotColors(): PlotColors {
    const theme = useTheme();
    const [colors, setColors] = useState(read);
    const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
    useEffect(() => {
        const query = window.matchMedia?.("(prefers-color-scheme: dark)");
        if (!query) {
            return;
        }
        const changed = () => setDark(query.matches);
        query.addEventListener("change", changed);
        return () => query.removeEventListener("change", changed);
    }, []);
    useEffect(() => setColors(read()), [theme, dark]);
    return colors;
}
