import type { Layout } from "./layout";

// From a dataset's or a view's plots to its Python and Models: what they have (their tests, the channels plotted, the
// time in view), so a page's notebook starts on those channels and a model with the test picked, over that time.

/** What a dataset's or view's page has, for its Python and Models. */
export interface Handoff {
    title: string; // what it is: "Hotfire 3", or the view's name
    datasets: number[]; // the tests plotted, the first first
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
    return { title, datasets: layout.datasets.map((ref) => ref.id), channels, window: layout.window };
}

/** Models, with the first test picked and its time in view as the run's window. */
export function modelsLink(handoff: Handoff): string {
    const window = handoff.window ? `&window=${handoff.window.map((t) => String(t)).join(",")}` : "";
    return `/yorg/models?dataset=${handoff.datasets[0] ?? ""}${window}`;
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

/**
 * A page's notebook to start from (cells: "# %%"): the channels it plots, loaded in one cell, and in the next, each
 * over the time in view as it is when it runs (yorg.window; a compared test's by its own clock: yorg.shifts).
 */
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
        `# Python on **${handoff.title || nameOf(first ?? 0)}**: \`yorg.window\` is the time in view, \`yorg.t0\` its T0, and`,
        "# `yorg.plot` draws on this page's plots, on its time axis.",
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
        lines.push('# Name a channel in quotes: yorg.channel("PT-TANK") (Ctrl+Space in the quotes lists them).');
        return `${lines.join("\n")}\n`;
    }
    const test = byId ? "{channel.dataset} {channel.dataset_id}" : "{channel.dataset}";
    lines.push(
        "",
        "# %% Each one, in view",
        "start, end = yorg.window  # s, on the first test's clock",
        `for channel in (${variables.join(", ")}${variables.length === 1 ? "," : ""}):`,
        "    shift = yorg.shifts.get(channel.dataset_id, 0.0)  # a test moved to line up: by its own clock",
        "    part = channel.between(start - shift, end - shift)",
        `    print(f"{channel.name} (${test}): mean {part.values.mean():.4g} {channel.unit} in view")`,
    );
    return `${lines.join("\n")}\n`;
}
