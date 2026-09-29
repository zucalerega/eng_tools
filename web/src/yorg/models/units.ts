import type { Display, Quantity } from "./api";

// Models keep SI units (Pa absolute, K, m, m², m³, kg/s); the page shows them in US or SI engineering units, with
// pressures gauge (above the atmosphere) or absolute. Channels compared with a model are put in SI from their own
// units (PT-1 (psig)), or read in the model's when they have none, as the server does with the channels a run follows
// (server/src/cvc_server/yorg/system/channels.py).

export const PSI = 6894.757;
export const ATMOSPHERE = 101325;

interface Unit {
    label: string;
    scale: number; // SI per unit
    offset?: number; // for temperatures: display = SI / scale - offset
}

const FAHRENHEIT: Unit = { label: "°F", scale: 5 / 9, offset: 459.67 };

const US_PRESSURE: Unit = { label: "psi", scale: PSI };
const SI_PRESSURE: Unit = { label: "bar", scale: 1e5 };

const SYSTEMS: Record<Display["units"], Partial<Record<Quantity, Unit>>> = {
    us: {
        pressure: US_PRESSURE,
        pressure_abs: { label: "psia", scale: PSI },
        pressure_drop: US_PRESSURE,
        temperature: FAHRENHEIT,
        length: { label: "ft", scale: 0.3048 },
        diameter: { label: "in", scale: 0.0254 },
        area: { label: "in²", scale: 0.00064516 },
        volume: { label: "gal", scale: 0.003785411784 },
        density: { label: "lbm/ft³", scale: 16.01846337 },
        mass: { label: "lbm", scale: 0.45359237 },
        specific_heat: { label: "BTU/lbm·°F", scale: 4186.8 },
        conductance: { label: "BTU/hr·°F", scale: 0.52752793 },
        mass_flow: { label: "lbm/s", scale: 0.45359237 },
        time: { label: "s", scale: 1 },
    },
    si: {
        pressure: SI_PRESSURE,
        pressure_abs: { label: "bara", scale: 1e5 },
        pressure_drop: SI_PRESSURE,
        temperature: { label: "K", scale: 1 },
        length: { label: "m", scale: 1 },
        diameter: { label: "mm", scale: 0.001 },
        area: { label: "mm²", scale: 1e-6 },
        volume: { label: "L", scale: 0.001 },
        density: { label: "kg/m³", scale: 1 },
        mass: { label: "kg", scale: 1 },
        specific_heat: { label: "J/kg·K", scale: 1 },
        conductance: { label: "W/K", scale: 1 },
        mass_flow: { label: "kg/s", scale: 1 },
        time: { label: "s", scale: 1 },
    },
};

/** What a quantity is shown in: "psig", "°F", "in²"; "" for ratios and raw numbers. */
export function unitOf(quantity: Quantity, display: Display): string {
    const unit = SYSTEMS[display.units][quantity];
    if (!unit) {
        return "";
    }
    return quantity === "pressure" ? `${unit.label}${display.gauge ? "g" : "a"}` : unit.label;
}

/** What's taken off before showing a quantity: the atmosphere, for a pressure shown gauge. */
const gaugeOf = (quantity: Quantity, display: Display) =>
    quantity === "pressure" && display.gauge ? display.ambient : 0;

export function toDisplay(quantity: Quantity, si: number, display: Display): number {
    const unit = SYSTEMS[display.units][quantity];
    if (!unit) {
        return si;
    }
    return (si - gaugeOf(quantity, display)) / unit.scale - (unit.offset ?? 0);
}

export function fromDisplay(quantity: Quantity, value: number, display: Display): number {
    const unit = SYSTEMS[display.units][quantity];
    if (!unit) {
        return value;
    }
    return (value + (unit.offset ?? 0)) * unit.scale + gaugeOf(quantity, display);
}

/** The units a run reads channels without a unit in: the model's. */
export function readingFor(display: Display): { pressure: string; temperature: string; mass_flow: string } {
    return display.units === "us"
        ? { pressure: "psi", temperature: "F", mass_flow: "lbm/s" }
        : { pressure: "bar", temperature: "K", mass_flow: "kg/s" };
}

const PRESSURES: Record<string, number> = {
    pa: 1,
    kpa: 1e3,
    mpa: 1e6,
    bar: 1e5,
    mbar: 100,
    psi: PSI,
    ksi: 1000 * PSI,
    atm: ATMOSPHERE,
    torr: 133.322,
    mmhg: 133.322,
    inhg: 3386.39,
};
const MASS_FLOWS: Record<string, number> = {
    "kg/s": 1,
    "g/s": 1e-3,
    "kg/min": 1 / 60,
    "lb/s": 0.45359237,
    "lbm/s": 0.45359237,
    "lbs/s": 0.45359237,
    "lb/min": 0.45359237 / 60,
    "lbm/min": 0.45359237 / 60,
};

const key = (unit: string) => unit.toLowerCase().replace(/[\s°º]|deg/g, "");

/** A linear map, value * scale + offset: every unit here is one (temperatures included). */
export interface Linear {
    scale: number;
    offset: number;
}

/** From SI to the model's units. */
export function siToDisplayLinear(quantity: Quantity, display: Display): Linear {
    const unit = SYSTEMS[display.units][quantity];
    if (!unit) {
        return { scale: 1, offset: 0 };
    }
    return { scale: 1 / unit.scale, offset: -gaugeOf(quantity, display) / unit.scale - (unit.offset ?? 0) };
}

/** From a channel's values (in its unit, or the model's if it has none) to SI. */
export function channelToSiLinear(quantity: Quantity, unit: string, display: Display): Linear {
    const reading = readingFor(display);
    let found = key(unit);
    if (quantity === "pressure") {
        let gauge = display.gauge;
        if (/[ga]$/.test(found) && found.slice(0, -1) in PRESSURES) {
            gauge = found.endsWith("g");
            found = found.slice(0, -1);
        }
        if (!(found in PRESSURES)) {
            found = key(reading.pressure);
            gauge = display.gauge;
        }
        return { scale: PRESSURES[found] ?? PSI, offset: gauge ? display.ambient : 0 };
    }
    if (quantity === "temperature") {
        const which = ["k", "c", "f", "r"].includes(found) ? found : key(reading.temperature);
        return which === "c"
            ? { scale: 1, offset: 273.15 }
            : which === "f"
              ? { scale: 5 / 9, offset: 273.15 - (32 * 5) / 9 }
              : which === "r"
                ? { scale: 5 / 9, offset: 0 }
                : { scale: 1, offset: 0 };
    }
    if (quantity === "mass_flow") {
        return { scale: MASS_FLOWS[found] ?? MASS_FLOWS[key(reading.mass_flow)] ?? 1, offset: 0 };
    }
    return { scale: 1, offset: 0 };
}
