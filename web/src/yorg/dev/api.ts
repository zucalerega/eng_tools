import { request } from "../../api";

// The dev page's API (/api/yorg/dev, for admins): system models and runs of them against a test's data. Every value
// the server sends or takes is in SI units (Pa absolute, K, m, m², m³, kg/s); units.ts shows them in the model's units.

export type Quantity =
    | "pressure"
    | "temperature"
    | "length"
    | "diameter"
    | "area"
    | "volume"
    | "density"
    | "time"
    | "ratio"
    | "number"
    | "choice"
    | "mass_flow"
    | "command";

export interface Setting {
    key: string;
    label: string;
    quantity: Quantity;
    default: number | string;
    minimum: number | null;
    maximum: number | null;
    tunable: boolean;
    choices: string[];
    only_when: [string, string] | null;
    help: string;
}

export interface Link {
    key: string;
    label: string;
    quantity: Quantity;
    role: "boundary" | "sensor" | "command";
    help: string;
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
    phase: "liquid" | "gas";
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

export interface RunResult {
    times: number[];
    series: Record<string, (number | null)[]>; // by part.output
    liquids: Record<string, { fluid: string; temperature: number; density: number; phase: string }>;
    notes: string[];
    steps: number;
    elapsed: number;
}

export type RunStatus =
    | { state: "running"; elapsed: number; done: number; duration: number }
    | { state: "done"; elapsed: number; duration: number; result: RunResult }
    | { state: "failed"; elapsed: number; duration: number; message: string };

export interface RunRequest {
    model: SystemModel;
    dataset_id: number;
    start: number;
    end: number;
    dt: number;
    reading: { pressure: string; temperature: string; mass_flow: string };
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
    status: (id: string) => request<RunStatus>("GET", `/api/yorg/dev/runs/${id}`),
    stop: (id: string) => request<void>("DELETE", `/api/yorg/dev/runs/${id}`),
};
