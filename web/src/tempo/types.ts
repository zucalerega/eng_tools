export type ValveInitial = "OPEN" | "CLOSED";

export interface ValveConfig {
    name: string;
    initial: ValveInitial;
}

export type SensorUnit = "psi" | "V" | "A" | "lbf" | "K" | "unknown";
export type SensorMode = "time" | "valve";
export type SensorInterpolation = "step" | "linear";

export interface SensorSample {
    at: number | string;
    value: number | string;
}

export interface SensorConfig {
    name: string;
    unit: SensorUnit;
    mode: SensorMode;
    initial: number | string;
    min: number | null;
    max: number | null;
    valves: string[];
    rates: Record<string, number | string>;
    interpolation: SensorInterpolation;
    samples: SensorSample[];
}

export interface TestEnvironment {
    valves: ValveConfig[];
    sensors: SensorConfig[];
}

export type CheckStatus = "pass" | "warn" | "partial" | "fail" | "not-run" | "skipped";

export interface Diagnostic {
    stage: string;
    severity: "error" | "warning" | "info";
    message: string;
    line: number;
}

export interface SimulationEvent {
    time: number;
    kind: string;
    target: string;
    detail: string;
    line: number;
}

export interface SensorTrace {
    name: string;
    unit: string;
    mode?: string;
    valves?: string[];
    rates?: Record<string, number>;
    interpolation?: string;
    min?: number | null;
    max?: number | null;
    samples: { at: number; value: number }[];
}

export interface AbortStageCoverage {
    name: string;
    condition: string;
    defined_line: number;
    activated: boolean;
    triggered: number | null;
    safing: Record<string, { state: string; delay_ms: number }>;
}

export interface SimulationTiming {
    mode?: string;
    requested_speed?: number | null;
    wall_seconds: number;
    actual_speed?: number | null;
    wait_count?: number;
    max_wait_overshoot_ms?: number;
    simulated_limit_seconds?: number;
}

export interface SimulationResult {
    checks: {
        syntax: CheckStatus;
        names: CheckStatus;
        api: CheckStatus;
        runtime: CheckStatus;
    };
    diagnostics: Diagnostic[];
    events: SimulationEvent[];
    virtual_time: number;
    timing?: SimulationTiming;
    valves: Record<string, string>;
    stdout: string;
    simulation?: {
        initial_valves: Record<string, string>;
        sensors: SensorTrace[] | Record<string, Omit<SensorTrace, "name"> & { name?: string }>;
        sensor_read_lines: Record<string, number[]>;
        abort_stages: AbortStageCoverage[];
        aborted: boolean;
    };
}

export interface CompatibilityBaseline {
    schema_version: number;
    repo: string;
    tester_sha: string;
    luna_sha: string;
    synced_at: string;
    files: Record<string, string>;
}

export interface CompatibilityReport {
    state: "verified" | "warning" | "unknown";
    label: string;
    detail: string;
    lunaSha: string;
    testerSha: string;
}

export interface TempoTestSummary {
    id: number;
    name: string;
    version: number;
    owner_id: number;
    owner_name: string;
    updated_by_id: number | null;
    updated_by_name: string;
    created_at: string;
    updated_at: string;
    can_change: boolean;
    valve_count: number;
    sensor_count: number;
    line_count: number;
}

export interface TempoTestDetail extends TempoTestSummary {
    source: string;
    environment: TestEnvironment;
}

export interface TempoEnvironmentRecord {
    id: number;
    name: string;
    description: string;
    environment: TestEnvironment;
    version: number;
    owner_id: number;
    owner_name: string;
    updated_by_id: number | null;
    updated_by_name: string;
    created_at: string;
    updated_at: string;
    can_change: boolean;
}
