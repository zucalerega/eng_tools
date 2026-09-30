import type { Layout } from "./layout";

// From a dataset's or a view's plots to Scripts and Models: what they had (their tests, the channels plotted, the time
// in view) goes along in the link, so a script starts with those channels loaded and a model with the test picked.

/** What a dataset's or view's page hands Scripts and Models. */
export interface Handoff {
    title: string; // what it came from: "Hotfire 3", or the view's name
    datasets: number[]; // the tests plotted, the first first
    shifts: Record<number, number>; // each test's shift on the time axis (a view's second test, moved to line up)
    channels: { dataset: number; name: string }[]; // those plotted, each once
    window: [number, number] | null; // the time in view, on the first test's clock
}

export function handoffOf(layout: Layout, title: string): Handoff {
    const channels: Handoff["channels"] = [];
    for (const panel of layout.panels) {
        for (const series of panel.series) {
            // A calculated channel isn't one of the test's: a script can't take it by name.
            if (
                series.formula === null &&
                !channels.some((one) => one.dataset === series.dataset && one.name === series.channel)
            ) {
                channels.push({ dataset: series.dataset, name: series.channel });
            }
        }
    }
    return {
        title,
        datasets: layout.datasets.map((ref) => ref.id),
        shifts: Object.fromEntries(layout.datasets.map((ref) => [ref.id, ref.shift])),
        channels,
        window: layout.window,
    };
}

/** Scripts, with a new script on what a page had. */
export const scriptsLink = (handoff: Handoff): string =>
    `/yorg/scripts?from=${encodeURIComponent(JSON.stringify(handoff))}`;

/** Models, with the first test picked and its time in view as the run's window. */
export function modelsLink(handoff: Handoff): string {
    const window = handoff.window ? `&window=${handoff.window.map((t) => String(t)).join(",")}` : "";
    return `/yorg/models?dataset=${handoff.datasets[0] ?? ""}${window}`;
}

/** What a link to Scripts brought (null: nothing, or nothing readable). */
export function readHandoff(search: string): Handoff | null {
    const raw = new URLSearchParams(search).get("from");
    if (!raw) {
        return null;
    }
    try {
        const found = JSON.parse(raw) as Partial<Handoff>;
        if (!Array.isArray(found.datasets) || !found.datasets.every((id) => typeof id === "number")) {
            return null;
        }
        return {
            title: typeof found.title === "string" ? found.title : "",
            datasets: found.datasets,
            shifts: found.shifts ?? {},
            channels: Array.isArray(found.channels)
                ? found.channels.filter((one) => typeof one?.name === "string" && typeof one?.dataset === "number")
                : [],
            window:
                Array.isArray(found.window) && found.window.length === 2 && found.window.every(Number.isFinite)
                    ? [found.window[0]!, found.window[1]!]
                    : null,
        };
    } catch {
        return null;
    }
}

/** A Python name for a channel, not one taken already: PT-TANK is pt_tank (then pt_tank_2). */
export function variableName(channel: string, taken: Set<string>): string {
    let name = channel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (!name || /^\d/.test(name)) {
        name = `ch_${name}`;
    }
    let found = name;
    for (let count = 2; taken.has(found); count += 1) {
        found = `${name}_${count}`;
    }
    taken.add(found);
    return found;
}

const number = (value: number) => String(Number(value.toPrecision(10)));

/** A notebook to start from (cells: "# %%"): what the page had, loaded in one cell, and over its window in the next. */
export function starterScript(handoff: Handoff, names: Record<number, string>): string {
    const first = handoff.datasets[0];
    const nameOf = (id: number) => names[id] ?? `test ${id}`;
    // Code names a test by its name, or by its id where two of the page's tests have that name (in two folders).
    const shared = (id: number) =>
        handoff.datasets.some((other) => other !== id && nameOf(other).toLowerCase() === nameOf(id).toLowerCase());
    const byId = handoff.datasets.some(shared);
    const refOf = (id: number) => (shared(id) ? String(id) : JSON.stringify(nameOf(id)));
    const lines = [
        "# %% [markdown]",
        `# From **${handoff.title || nameOf(first ?? 0)}**: the channels it plotted${handoff.window ? ", over the time in view" : ""}.`,
        "",
        "# %% Load the channels",
    ];
    const taken = new Set<string>();
    const variables: string[] = [];
    for (const one of handoff.channels) {
        const variable = variableName(one.name, taken);
        variables.push(variable);
        const other = one.dataset === first ? "" : `, dataset=${refOf(one.dataset)}`;
        lines.push(`${variable} = yorg.channel(${JSON.stringify(one.name)}${other})`);
    }
    if (variables.length === 0) {
        lines.push("# Click a channel under Data to add it here.");
        return `${lines.join("\n")}\n`;
    }
    if (handoff.window) {
        lines.push(
            `start, end = ${number(handoff.window[0])}, ${number(handoff.window[1])}  # s, on ${nameOf(first ?? 0)}'s clock`,
        );
    }
    lines.push("", `# %% Each one${handoff.window ? ", over the time in view" : ""}`);
    lines.push(`for channel in (${variables.join(", ")}${variables.length === 1 ? "," : ""}):`);
    if (handoff.window) {
        const shifted = handoff.channels.some((one) => (handoff.shifts[one.dataset] ?? 0) !== 0);
        if (shifted) {
            lines.push("    # A test moved on the view's time axis: its own clock, back by its shift.");
            const shifts = handoff.datasets
                .filter((id) => (handoff.shifts[id] ?? 0) !== 0)
                .map((id) => `${byId ? id : JSON.stringify(nameOf(id))}: ${number(handoff.shifts[id]!)}`)
                .join(", ");
            lines.push(`    shift = {${shifts}}.get(channel.${byId ? "dataset_id" : "dataset"}, 0.0)`);
            lines.push("    part = channel.between(start - shift, end - shift)");
        } else {
            lines.push("    part = channel.between(start, end)");
        }
    } else {
        lines.push("    part = channel");
    }
    const test = byId ? "{channel.dataset} {channel.dataset_id}" : "{channel.dataset}";
    lines.push(`    print(f"{channel.name} (${test}): mean {part.values.mean():.4g} {channel.unit}")`);
    lines.push(
        `    yorg.plot(part, name=${byId ? `f"${test}"` : "channel.dataset"}, title=channel.name)  # a plot for each channel, each test in it`,
    );
    return `${lines.join("\n")}\n`;
}
