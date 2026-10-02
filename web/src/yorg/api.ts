// Yorg's part of the server's API (server/src/yjsp_server/yorg/schemas.py, or /docs on a running server).

import { apiUrl, request, requestBytes, uploadFile, type UserRef } from "../api";

export interface Channel {
    name: string;
    unit: string;
    kind: "number" | "state"; // a state: text, numbered in the order of labels
    labels: string[];
    decimals: number | null; // the most digits after the point in the file
    count: number; // samples with a value
    min: number | null;
    max: number | null;
    mean: number | null;
    t_min: number | null;
    t_max: number | null;
    column: number; // in the file, from 1
    time: string; // its arrays, in the dataset's data (arrayUrl)
    values: string;
}

/** A step in a text column that was mostly empty (a sequence's IGNITION, say): a marker on the plots. */
export interface DataEvent {
    t: number;
    label: string;
    channel: string;
}

export type TimeKind = "relative" | "absolute" | "clock";

export interface Dataset {
    id: number;
    folder_id: number | null; // the folder it's in; null: at the top
    name: string;
    description: string;
    filename: string;
    size: number;
    status: "reading" | "ready" | "failed";
    error: string | null;
    rows: number;
    channel_count: number;
    // Times are seconds. relative: as the file had them; absolute: after start_epoch (Unix seconds); clock: times
    // of day, after start_epoch seconds past midnight.
    time_kind: TimeKind | null;
    start_epoch: number | null;
    t_min: number | null;
    t_max: number | null;
    sample_rate: number | null;
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    deleted_at: string | null;
    deleted_by: UserRef | null;
    can_change: boolean; // yours, or you're an admin: rename it, read it again, delete it
}

export const TIME_FORMATS = {
    auto: "Worked out from the file",
    seconds: "Seconds",
    milliseconds: "Milliseconds",
    microseconds: "Microseconds",
    nanoseconds: "Nanoseconds",
    unix_seconds: "Unix time, seconds",
    unix_milliseconds: "Unix time, milliseconds",
    unix_microseconds: "Unix time, microseconds",
    unix_nanoseconds: "Unix time, nanoseconds",
    datetime: "Dates and times",
    rows: "None: time is the row number",
} as const;

export type TimeFormat = keyof typeof TIME_FORMATS;

export const DELIMITERS = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe", " ": "Spaces" } as const;

export type Delimiter = keyof typeof DELIMITERS;

/** How to read a dataset's file; anything left out is worked out from the file. */
export interface ReadOptions {
    time_column?: string | null;
    time_format?: TimeFormat;
    sample_rate?: number | null; // rows per second, when time is the row number
    header_row?: number | null; // the names' row, from 1; 0: the file has no names
    delimiter?: Delimiter | null;
}

/** How the file was read. */
export interface ReadInfo {
    encoding?: string;
    delimiter?: string;
    decimal_comma?: boolean;
    header_row?: number;
    units_row?: number | null;
    first_data_row?: number;
    time_column?: string | null;
    time_format?: TimeFormat;
    utc_offset?: number | null;
    split_from?: SplitFrom; // a piece of another dataset (a test, out of a file of several): it has no file of its own
}

/** Where a piece of a dataset came from: that dataset, and the span of its times, counted from zero. */
export interface SplitFrom {
    dataset: number;
    name: string;
    start: number;
    end: number;
    zero: number | null;
}

/** A span of a dataset to make a dataset of: in its own seconds, with zero's time as 0 (null: times as they are). */
export interface PieceBody {
    name: string;
    start: number;
    end: number;
    zero: number | null;
}

export interface DatasetDetail extends Dataset {
    data_version: string | null;
    channels: Channel[];
    events: DataEvent[];
    warnings: string[];
    read_options: ReadOptions;
    read_info: ReadInfo;
}

/** A folder of datasets (a test campaign, say): in another folder, or at the top (parent_id null). */
export interface DataFolder {
    id: number;
    parent_id: number | null;
    name: string;
    created_at: string;
    created_by: UserRef | null;
    can_change: boolean; // yours, or you're an admin: rename it, move it, delete it (if it's empty)
}

/** A calculated channel, for the whole team: an expression over channels, by name (formula.ts reads it). */
export interface Formula {
    id: number;
    name: string;
    expression: string;
    unit: string;
    description: string;
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    can_change: boolean;
}

export interface FormulaBody {
    name: string;
    expression: string;
    unit: string;
    description: string;
}

export interface SavedView {
    id: number;
    name: string;
    folder: string; // a path of its own ("Hotfires/HF-3"), "" at the top
    description: string;
    datasets: number[];
    config: unknown; // a Layout, as this app saved it (layout.ts reads it)
    created_at: string;
    created_by: UserRef | null;
    updated_at: string;
    updated_by: UserRef | null;
    can_change: boolean;
}

export interface ViewBody {
    name: string;
    folder?: string; // left out: at the top for a new view, where it was for a changed one
    description: string;
    datasets: number[];
    config: unknown;
}

const datasetPath = (id: number) => `/api/yorg/datasets/${id}`;

export const yorg = {
    datasets: (deleted = false) => request<Dataset[]>("GET", "/api/yorg/datasets" + (deleted ? "?deleted=true" : "")),
    dataset: (id: number) => request<DatasetDetail>("GET", datasetPath(id)),
    /** Upload a file and read it. One that can't be read comes back with status "failed" and error. */
    upload: (file: File, onProgress: (sent: number) => void, name?: string, folder: number | null = null) =>
        uploadFile<DatasetDetail>(
            "/api/yorg/datasets?" +
                new URLSearchParams({
                    filename: file.name,
                    ...(name ? { name } : {}),
                    ...(folder === null ? {} : { folder: String(folder) }),
                }).toString(),
            file,
            onProgress,
        ),
    /** Put datasets in a folder (null: the top): all of them, or none if any isn't yours to move. */
    move: (datasets: number[], folder: number | null) =>
        request<Dataset[]>("POST", "/api/yorg/datasets/move", { datasets, folder_id: folder }),
    folders: () => request<DataFolder[]>("GET", "/api/yorg/folders"),
    addFolder: (name: string, parent: number | null) =>
        request<DataFolder>("POST", "/api/yorg/folders", { name, parent_id: parent }),
    renameFolder: (id: number, name: string) => request<DataFolder>("PATCH", `/api/yorg/folders/${id}`, { name }),
    moveFolder: (id: number, parent: number | null) =>
        request<DataFolder>("PATCH", `/api/yorg/folders/${id}`, { parent_id: parent }),
    removeFolder: (id: number) => request<void>("DELETE", `/api/yorg/folders/${id}`),
    update: (id: number, change: { name?: string; description?: string }) =>
        request<Dataset>("PATCH", datasetPath(id), change),
    /** Read the file again another way. If that doesn't work, this fails, and the last read stays. */
    read: (id: number, options: ReadOptions) => request<DatasetDetail>("POST", datasetPath(id) + "/read", options),
    /** Make datasets of spans of one (its tests), in a folder: all of them, or none if a span has no samples. */
    split: (id: number, pieces: PieceBody[], folder: number | null) =>
        request<Dataset[]>("POST", datasetPath(id) + "/split", { pieces, folder_id: folder }),
    remove: (id: number) => request<Dataset>("DELETE", datasetPath(id)),
    restore: (id: number) => request<Dataset>("POST", datasetPath(id) + "/restore"),
    sourceUrl: (id: number) => apiUrl(datasetPath(id) + "/source"),
    /** One of a read's arrays (a channel's time or values): little-endian float64, which browsers keep. */
    array: async (dataset: DatasetDetail, file: string): Promise<Float64Array> =>
        new Float64Array(await requestBytes(`${datasetPath(dataset.id)}/data/${dataset.data_version}/${file}`)),
    formulas: () => request<Formula[]>("GET", "/api/yorg/formulas"),
    addFormula: (body: FormulaBody) => request<Formula>("POST", "/api/yorg/formulas", body),
    updateFormula: (id: number, body: FormulaBody) => request<Formula>("PUT", `/api/yorg/formulas/${id}`, body),
    removeFormula: (id: number) => request<void>("DELETE", `/api/yorg/formulas/${id}`),
    views: () => request<SavedView[]>("GET", "/api/yorg/views"),
    view: (id: number) => request<SavedView>("GET", `/api/yorg/views/${id}`),
    saveView: (body: ViewBody) => request<SavedView>("POST", "/api/yorg/views", body),
    updateView: (id: number, body: ViewBody) => request<SavedView>("PUT", `/api/yorg/views/${id}`, body),
    removeView: (id: number) => request<void>("DELETE", `/api/yorg/views/${id}`),
};
