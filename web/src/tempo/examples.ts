import type { SensorConfig, SensorUnit, TestEnvironment, ValveConfig } from "./types";

const VALID_UNITS = new Set<SensorUnit>(["psi", "V", "A", "lbf", "K", "unknown"]);

export interface ExampleSequence {
    id: string;
    label: string;
    name: string;
    source: string;
    environment: TestEnvironment;
}

export const DEFAULT_ENVIRONMENT: TestEnvironment = {
    valves: [
        { name: "press_valve", initial: "CLOSED" },
        { name: "vent_valve", initial: "CLOSED" },
    ],
    sensors: [
        {
            name: "tank_pt",
            unit: "psi",
            mode: "time",
            initial: 0,
            min: null,
            max: null,
            valves: [],
            rates: {},
            interpolation: "step",
            samples: [
                { at: 0, value: 0 },
                { at: 1, value: 120 },
                { at: 2, value: 220 },
                { at: 3, value: 315 },
            ],
        },
    ],
};

function sensor(partial: Partial<SensorConfig> & { name: string }): SensorConfig {
    return {
        name: partial.name,
        unit: partial.unit && VALID_UNITS.has(partial.unit) ? partial.unit : "unknown",
        mode: partial.mode === "valve" ? "valve" : "time",
        initial: partial.initial ?? 0,
        min: partial.min ?? null,
        max: partial.max ?? null,
        valves: partial.valves ? [...partial.valves] : [],
        rates: partial.rates ? { ...partial.rates } : {},
        interpolation: partial.interpolation === "linear" ? "linear" : "step",
        samples: partial.samples ? partial.samples.map((s) => ({ at: s.at, value: s.value })) : [{ at: 0, value: 0 }],
    };
}

function valve(name: string, initial: "OPEN" | "CLOSED" = "CLOSED"): ValveConfig {
    return { name, initial };
}

export function normalizeEnvironment(raw: unknown, fallback: TestEnvironment = DEFAULT_ENVIRONMENT): TestEnvironment {
    let data: unknown = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            data = fallback;
        }
    }
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    if (!obj || !Array.isArray(obj.valves) || !Array.isArray(obj.sensors)) {
        return normalizeEnvironment(fallback, { valves: [], sensors: [] });
    }
    const valves: ValveConfig[] = obj.valves.map((entry) => {
        if (typeof entry === "string") {
            return { name: entry, initial: "CLOSED" };
        }
        const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        return {
            name: typeof item.name === "string" ? item.name : "",
            initial: item.initial === "OPEN" ? "OPEN" : "CLOSED",
        };
    });
    const sensors: SensorConfig[] = obj.sensors.map((entry) => {
        const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const unit =
            typeof item.unit === "string" && VALID_UNITS.has(item.unit as SensorUnit)
                ? (item.unit as SensorUnit)
                : "unknown";
        const mode = item.mode === "valve" ? "valve" : "time";
        const rawSamples = Array.isArray(item.samples) ? item.samples : [{ at: 0, value: 0 }];
        const samples = rawSamples.map((pt) => {
            const p = pt && typeof pt === "object" ? (pt as Record<string, unknown>) : {};
            return {
                at: typeof p.at === "number" || typeof p.at === "string" ? p.at : 0,
                value: typeof p.value === "number" || typeof p.value === "string" ? p.value : 0,
            };
        });
        const rates: Record<string, number | string> = {};
        if (item.rates && typeof item.rates === "object" && !Array.isArray(item.rates)) {
            for (const [k, v] of Object.entries(item.rates as Record<string, unknown>)) {
                if (typeof v === "number" || typeof v === "string") {
                    rates[k] = v;
                }
            }
        }
        return {
            name: typeof item.name === "string" ? item.name : "",
            unit,
            mode,
            initial: typeof item.initial === "number" || typeof item.initial === "string" ? item.initial : 0,
            min: typeof item.min === "number" && Number.isFinite(item.min) ? item.min : null,
            max: typeof item.max === "number" && Number.isFinite(item.max) ? item.max : null,
            valves: Array.isArray(item.valves) ? item.valves.filter((v): v is string => typeof v === "string") : [],
            rates,
            interpolation: item.interpolation === "linear" ? "linear" : "step",
            samples,
        };
    });
    return { valves, sensors };
}

export const EXAMPLES: ExampleSequence[] = [
    {
        id: "vespula",
        label: "Vespula prePress",
        name: "vespula_prepress",
        source: "# tank pre press sequence\nimport time\nprint('Pre Press Sequence has begun')\n\n# define pressure variables\nftpt_target = 416*psi # psia, target fuel tank pressure\notpt_target = 357*psi # psia, target lox tank pressure\nupRan = 2*psi # psi, upper range bound for bang bang algorithm\nlowRan = 3*psi # psi, lower range bound for bang bang algorithm\n\n# time variables\npress_time = 20 # s, sequence duration\nwait_timing = 5 # ms\n\n# confirm switch closed\nFSWV.close()\nOSWV.close()\nwait_for(wait_timing*ms)\n\n# initialize valve state variables\nFBB.close()\nFBBopen = False # hardcoded for consistency\nOBB.close()\nOBBopen = False # hardcoded due to feedback issues on sam-21\n\nstart_time = time.time() # s, current time\n\n# press tanks with bang bang algorithm\nwhile time.time() < start_time + press_time:\n\t# check pressures\n\tcurrFTPT = FTPT.read()\n\tcurrOTPT = OTPT.read()\n\t# bang bang algorithm\n\tif FBBopen and currFTPT > ftpt_target + upRan:\n\t\tFBB.close()\n\t\tFBBopen = False\n\telif (not FBBopen) and currFTPT < ftpt_target - lowRan:\n\t\tFBB.open()\n\t\tFBBopen = True\n\tif OBBopen and currOTPT > otpt_target + upRan:\n\t\tOBB.close()\n\t\tOBBopen = False\n\telif (not OBBopen) and currOTPT < otpt_target - lowRan:\n\t\tOBB.open()\n\t\tOBBopen = True\n\twait_for(wait_timing*ms)\n\nOBB.close()\nFBB.close()\n\nprint('Pre Press Sequence has ended')",
        environment: {
            valves: [valve("FSWV"), valve("OSWV"), valve("FBB"), valve("OBB")],
            sensors: [
                sensor({
                    name: "FTPT",
                    unit: "psi",
                    mode: "valve",
                    initial: 400,
                    valves: ["FBB"],
                    rates: { "0": -2, "1": 30 },
                    min: 0,
                    max: 500,
                }),
                sensor({
                    name: "OTPT",
                    unit: "psi",
                    mode: "valve",
                    initial: 330,
                    valves: ["OBB"],
                    rates: { "0": -2, "1": 30 },
                    min: 0,
                    max: 500,
                }),
            ],
        },
    },
    {
        id: "feedback",
        label: "Valve-driven CTPT",
        name: "valve_driven_ctpt",
        source: `# Idealized pressure feedback demo (not a physical tank model)\nCISO.open()\nwait_until(lambda: CTPT.read() >= 340*psi, 5*s)\nCISO.close()\nCMV.open()\nwait_until(lambda: CTPT.read() <= 250*psi, 5*s)\nCMV.close()\nprint("Pressure-control sequence complete")`,
        environment: {
            valves: [valve("CISO"), valve("CMV")],
            sensors: [
                sensor({
                    name: "CTPT",
                    unit: "psi",
                    mode: "valve",
                    initial: 100,
                    valves: ["CISO", "CMV"],
                    rates: { "00": 0, "01": -60, "10": 80, "11": 20 },
                    min: 0,
                    max: 500,
                }),
            ],
        },
    },
    {
        id: "tank",
        label: "Tank press",
        name: "tank_press",
        source: `press_valve.open()\nwait_until(lambda: tank_pt.read() >= 300 * psi, 5 * s)\npress_valve.close()\nprint("Tank press sequence finished")`,
        environment: DEFAULT_ENVIRONMENT,
    },
    {
        id: "abort",
        label: "Abort stage",
        name: "abort_stage",
        source: `# Abort triggers when the configured tank pressure exceeds 250 psi\ncreate_abort_stage(\n    "PRESSURIZATION",\n    "tank_pt.read() > 250*psi",\n    {press_valve: (CLOSED, 500), vent_valve: (OPEN, 1000)}\n)\nset_abort_stage("PRESSURIZATION")\npress_valve.open()\nwait_for(5*s)\nprint("Only reached if the abort condition never triggers")`,
        environment: {
            valves: [valve("press_valve"), valve("vent_valve")],
            sensors: [
                sensor({
                    name: "tank_pt",
                    unit: "psi",
                    mode: "valve",
                    initial: 0,
                    valves: ["press_valve", "vent_valve"],
                    rates: { "00": 0, "01": -60, "10": 100, "11": 40 },
                    min: 0,
                    max: 500,
                }),
            ],
        },
    },
    {
        id: "abort_two",
        label: "Two abort stages",
        name: "two_abort_stages",
        source: `# Adapted from YJSP Notion's GROUND and FILLING examples.\n# Demonstration thresholds only; not approved operational limits.\n# Safing timers are integer MILLISECONDS in current Luna.\ncreate_abort_stage(\n    "GROUND",\n    "PT.read() > 50*psi",\n    {press_valve: (CLOSED, 0), vent_valve: (OPEN, 0)}\n)\ncreate_abort_stage(\n    "FILLING",\n    "load_cell.read() > 40*lbf",\n    {press_valve: (CLOSED, 5000), vent_valve: (OPEN, 0)}\n)\nset_abort_stage("GROUND")\nwait_for(1*s)\nset_abort_stage("FILLING")\npress_valve.open()\nwait_for(5*s)\nprint("No abort triggered")`,
        environment: {
            valves: [valve("press_valve"), valve("vent_valve")],
            sensors: [
                sensor({
                    name: "PT",
                    unit: "psi",
                    mode: "valve",
                    initial: 30,
                    valves: ["press_valve"],
                    rates: { "0": 0, "1": 10 },
                    min: 0,
                    max: 500,
                }),
                sensor({
                    name: "load_cell",
                    unit: "lbf",
                    mode: "valve",
                    initial: 0,
                    valves: ["press_valve"],
                    rates: { "0": 0, "1": 15 },
                    min: 0,
                    max: 500,
                }),
            ],
        },
    },
    {
        id: "pulse",
        label: "Valve pulse",
        name: "valve_pulse",
        source: `press_valve.open()\nwait_for(500 * ms)\npress_valve.close()\nwait_for(250 * ms)\nvent_valve.open()\nwait_for(250 * ms)\nvent_valve.close()`,
        environment: DEFAULT_ENVIRONMENT,
    },
    {
        id: "import",
        label: "Missing import",
        name: "missing_import",
        source: `press_valve.open()\ntime.sleep(1)\npress_valve.close()`,
        environment: DEFAULT_ENVIRONMENT,
    },
    {
        id: "api",
        label: "API mistake",
        name: "api_mistake",
        source: `tank_pt.open()\npress_valve.open()\nwait_for(500 * ms)\npress_valve.close()`,
        environment: DEFAULT_ENVIRONMENT,
    },
];
