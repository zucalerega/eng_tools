import type { Layout } from "./layout";
import type { PlotColors } from "./Plot";
import { lowerBound, upperBound } from "./samples";
import type { Resolved } from "./Workspace";

// Taking plots away: an image of them as they are, or the samples in view as a CSV file.

function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The plots, one under another, each with its title and channels above it. */
export function exportImage(
    root: HTMLElement | null,
    layout: Layout,
    resolved: ReadonlyMap<string, Resolved[]>,
    colors: PlotColors,
): void {
    const canvases = [
        ...(root?.querySelectorAll<HTMLCanvasElement>(".yorg-panel .plot-canvas:not(.plot-overlay)") ?? []),
    ];
    if (canvases.length === 0) {
        return;
    }
    const ratio = window.devicePixelRatio || 1;
    const head = Math.round(26 * ratio);
    const width = Math.max(...canvases.map((canvas) => canvas.width));
    const height = canvases.reduce((total, canvas) => total + canvas.height + head, 0);
    const image = document.createElement("canvas");
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    if (!context) {
        return;
    }
    context.fillStyle = colors.plot;
    context.fillRect(0, 0, width, height);
    let top = 0;
    layout.panels.forEach((panel, index) => {
        const canvas = canvases[index];
        if (!canvas) {
            return;
        }
        context.font = `600 ${Math.round(12 * ratio)}px ${colors.font}`;
        context.textBaseline = "middle";
        let x = Math.round(10 * ratio);
        const middle = top + head / 2;
        context.fillStyle = colors.text;
        const title = panel.title || `Plot ${index + 1}`;
        context.fillText(title, x, middle);
        x += context.measureText(title).width + 16 * ratio;
        context.font = `${Math.round(12 * ratio)}px ${colors.font}`;
        for (const series of resolved.get(panel.id) ?? []) {
            if (series.spec.hidden) {
                continue;
            }
            context.fillStyle = series.spec.color;
            context.fillRect(x, middle - 5 * ratio, 10 * ratio, 10 * ratio);
            x += 14 * ratio;
            context.fillStyle = colors.text;
            const name = series.unit ? `${series.name} (${series.unit})` : series.name;
            context.fillText(name, x, middle);
            x += context.measureText(name).width + 14 * ratio;
        }
        context.drawImage(canvas, 0, top + head);
        top += head + canvas.height;
    });
    image.toBlob((blob) => blob && download(blob, "yorg-plots.png"), "image/png");
}

/** Every sample in view of the plotted channels: a row for each time any of them has one (masks hide the rest). */
export function exportCsv(
    layout: Layout,
    series: Resolved[],
    view: [number, number],
    time: { number: (x: number) => number },
): void {
    const shown = series.filter((one) => !one.spec.hidden && one.samples);
    const quote = (text: string) => (/[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
    const header = [layout.t0 === null ? "Time (s)" : "Time from T0 (s)"];
    const runs = shown.map((one) => {
        header.push(quote(one.unit ? `${one.name} (${one.unit})` : one.name));
        const { times, values } = one.samples!;
        const { shift, scale, offset } = one.placement;
        return {
            times,
            values,
            shift,
            scale,
            offset,
            next: lowerBound(times, view[0] - shift),
            end: upperBound(times, view[1] - shift),
        };
    });
    const parts: string[] = [header.join(",") + "\n"];
    let chunk: string[] = [];
    for (;;) {
        let x = Infinity;
        for (const run of runs) {
            if (run.next < run.end) {
                x = Math.min(x, run.times[run.next]! + run.shift);
            }
        }
        if (x === Infinity) {
            break;
        }
        const row = [String(time.number(x))];
        let any = false;
        for (const run of runs) {
            if (run.next < run.end && run.times[run.next]! + run.shift === x) {
                const value = run.values[run.next]!;
                row.push(Number.isNaN(value) ? "" : String(value * run.scale + run.offset));
                any ||= !Number.isNaN(value);
                run.next += 1;
            } else {
                row.push("");
            }
        }
        if (!any) {
            continue; // nothing here: every channel's missing, or hidden by a mask
        }
        chunk.push(row.join(","));
        if (chunk.length === 10_000) {
            parts.push(chunk.join("\n") + "\n");
            chunk = [];
        }
    }
    if (chunk.length > 0) {
        parts.push(chunk.join("\n") + "\n");
    }
    download(new Blob(parts, { type: "text/csv" }), "yorg-data.csv");
}
