import { request } from "../../api";

// The dev page's API (/api/yorg/dev, for admins): system models, and runs and fits of them against a test's data.
// Every value the server sends or takes is in SI units (Pa absolute, K, m, m², m³, kg/s); units.ts shows them in the
// model's units.

export type Quantity =
    | "pressure" // absolute, shown gauge or absolute
    | "pressure_abs" // always shown absolute (a vapor pressure)
    | "pressure_drop" // a difference (a regulator's droop)
    | "temperature"
    | "length"
    | "diameter"
    | "area"
    | "volume"
    | "density"
    | "mass"
    | "specific_heat"
    | "conductance" // hA, W/K
    | "time"
    | "ratio"
    | "number"
    | "choice"
    | "mass_flow"
    | "command";

/** When a setting or link matters: (setting, value) pairs that must all hold (none: always). */
export type Conditions = [string, string][];

export interface Setting {
    key: string;
    label: string;
    quantity: Quantity;
    default: number | string;
    minimum: number | null;
    maximum: number | null;
    tunable: boolean;
    choices: string[];
    choice_labels: string[]; // how each choice reads, if not as it is
    only_when: Conditions;
    help: string;
}

/**
 * boundary: the model follows the channel; start: its value at the run's start starts the model, which it's then
 * compared with; sensor: compared with the model; command: opens and closes a valve.
 */
export type Role = "boundary" | "start" | "sensor" | "command";

export interface Link {
    key: string;
    label: string;
    quantity: Quantity;
    role: Role;
    help: string;
    only_when: Conditions;
    start_when: Conditions | null; // a boundary that's a start instead, then (an ullage tank's pressure)
}

export interface Output {
    key: string;
    label: string;
    quantity: Quantity;
}

export interface PartKind {
    type: string;
    label: string;
    kind: "node" | "edge";
    phase: "liquid" | "gas" | "any";
    help: string;
    settings: Setting[];
    links: Link[];
    outputs: Output[];
}

export interface Catalog {
    parts: PartKind[];
    liquids: string[];
    gases: string[];
}

export interface Part {
    id: string;
    type: string;
    name: string;
    x: number;
    y: number;
    settings: Record<string, number | string>;
    links: Record<string, string>; // a link's key: the channel's name
}

export interface Edge extends Part {
    source: string;
    target: string;
}

export interface Display {
    units: "us" | "si";
    gauge: boolean; // pressures shown above the atmosphere
    ambient: number; // Pa
}

export interface SystemModel {
    version: 1;
    nodes: Part[];
    edges: Edge[];
    display: Display;
}

export interface SavedModel {
    id: string;
    name: string;
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
    model?: SystemModel;
}

/** A tank's liquid in a run: at its temperature, or following a channel's (then over the range it went through). */
export interface Liquid {
    fluid: string;
    temperature: number; // at the start
    density: number;
    vapor_pressure: number;
    phase: string;
    follows: string | null; // the temperature channel
    temperatures?: [number, number];
    densities?: [number, number];
}

/** A value a run started from, taken from a channel at the run's start. */
export interface Started {
    part: string;
    key: string; // the link's
    channel: string;
    quantity: Quantity;
    value: number;
}

export interface FitKnob {
    part: string;
    key: string;
    start: number;
    value: number;
}

export interface FitFound {
    knobs: FitKnob[];
    compared: { output: string; rms_start: number | null; rms: number | null }[];
    cost_start: number;
    cost: number;
    tries: number;
    stopped: boolean;
}

export interface RunResult {
    times: number[];
    series: Record<string, (number | null)[]>; // by part.output
    liquids: Record<string, Liquid>;
    initial: Started[];
    notes: string[];
    steps: number;
    elapsed: number;
    fit?: FitFound; // a fit's result: the best run, and what it found
}

/** How a fit is going: its tries so far, and the best it has found (knob values in the order asked). */
export interface FitProgress {
    tries?: number;
    cost_start?: number;
    cost?: number;
    values?: number[] | null;
    elapsed?: number;
}

export type RunStatus =
    | { state: "running"; elapsed: number; done: number; duration: number; progress?: FitProgress }
    | { state: "done"; elapsed: number; duration: number; result: RunResult; progress?: FitProgress }
    | { state: "failed"; elapsed: number; duration: number; message: string; progress?: FitProgress };

export interface RunRequest {
    model: SystemModel;
    dataset_id: number;
    start: number;
    end: number;
    dt: number;
    reading: { pressure: string; temperature: string; mass_flow: string };
}

export interface FitRequest extends RunRequest {
    knobs: { part: string; key: string }[];
}

export const devApi = {
    catalog: () => request<Catalog>("GET", "/api/yorg/dev/catalog"),
    models: () => request<SavedModel[]>("GET", "/api/yorg/dev/models"),
    model: (id: string) => request<SavedModel>("GET", `/api/yorg/dev/models/${id}`),
    addModel: (name: string, model: SystemModel) =>
        request<SavedModel>("POST", "/api/yorg/dev/models", { name, model }),
    saveModel: (id: string, name: string, model: SystemModel) =>
        request<SavedModel>("PUT", `/api/yorg/dev/models/${id}`, { name, model }),
    removeModel: (id: string) => request<void>("DELETE", `/api/yorg/dev/models/${id}`),
    run: (body: RunRequest) => request<{ id: string }>("POST", "/api/yorg/dev/runs", body),
    fit: (body: FitRequest) => request<{ id: string }>("POST", "/api/yorg/dev/fits", body),
    status: (id: string) => request<RunStatus>("GET", `/api/yorg/dev/runs/${id}`),
    stop: (id: string) => request<void>("DELETE", `/api/yorg/dev/runs/${id}`),
};
