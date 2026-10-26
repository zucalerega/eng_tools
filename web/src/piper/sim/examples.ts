import { emptyDrawing, type Drawing, type LineSim, type Part, type PartSim, type Rotation } from "../drawing";
import { addPart, connect, updateLine, updatePart } from "../edit";
import { presetOf } from "../library/index";
import { ATMOSPHERE, PSI } from "./units";

// P&IDs to simulate (Simulation mode), to start from or learn from: a cold flow, a pressurized flow, and Vespula's prop
// system, whose run's data comes with it. Built with the editor's own changes, as the diagrams' example is
// (example.ts), with each part's settings in the model, in SI units.

const IN2 = 0.00064516; // m²
const CM2 = 1e-4; // m²

/** A drawing, built a part and a line at a time. */
function builder() {
    let drawing = emptyDrawing();
    return {
        /** A part, turned (or mirrored: "flip"), tagged, with properties and settings in the model of its own. */
        place(
            preset: string,
            x: number,
            y: number,
            {
                turn = 0,
                tag,
                props = {},
                sim,
            }: { turn?: Rotation | "flip"; tag?: string; props?: Record<string, string>; sim?: PartSim } = {},
        ): string {
            const added = addPart(drawing, presetOf(preset)!, { x, y });
            drawing = updatePart(added.drawing, added.id, (part: Part) => ({
                ...part,
                rotation: turn === "flip" ? 0 : turn,
                flip: turn === "flip",
                tag: tag ?? part.tag,
                props: { ...part.props, ...props },
                ...(sim ? { sim } : {}),
            }));
            return added.id;
        },
        /** A line from a part's port to another's, carrying a fluid, and modeled as it's said to be. */
        join(from: [string, string], to: [string, string], fluid: string, sim?: LineSim): string {
            const made = connect(drawing, { part: from[0], port: from[1] }, { part: to[0], port: to[1] })!;
            drawing = updateLine(made.drawing, made.id, (line) => ({ ...line, fluid, ...(sim ? { sim } : {}) }));
            return made.id;
        },
        get drawing(): Drawing {
            return drawing;
        },
    };
}

const settings = (values: PartSim["settings"], as = ""): PartSim => ({ as, settings: values });

/**
 * A cold flow: a water tank held at a pressure its transducer measures, a feed line (modeled as a line, with its
 * friction and its water's inertia), the main valve, the manifold's transducer, and an injector out to the air. Link
 * it to a test with PT-TANK, MOV-01, and PT-MANIFOLD, then tune its CdAs and its line's losses.
 */
export function coldFlow(): Drawing {
    const draw = builder();
    const tank = draw.place("tank", 0, -140, {
        tag: "TK-1",
        props: { fluid: "water", volume: "20 L" },
        sim: settings({ pressure: 300 * PSI + ATMOSPHERE }),
    });
    const tankPressure = draw.place("pressure-transducer", 80, -170, { tag: "PT-TANK" });
    draw.join([tank, "right-upper"], [tankPressure, "left"], "water");
    const valve = draw.place("pneumatic-valve", 0, 60, { turn: 90, tag: "MOV-01", sim: settings({ cda: 5e-5 }) });
    draw.join([tank, "bottom"], [valve, "a"], "water", { line: { length: 1, diameter: 0.0127 }, node: {} });
    const manifold = draw.place("junction", 0, 140);
    draw.join([valve, "b"], [manifold, "c"], "water");
    const manifoldPressure = draw.place("pressure-transducer", -80, 140, { tag: "PT-MANIFOLD" });
    draw.join([manifoldPressure, "right"], [manifold, "c"], "water");
    const injector = draw.place("orifice", 0, 220, { turn: 90, tag: "INJ", sim: settings({ cda: 3e-5 }) });
    draw.join([manifold, "c"], [injector, "a"], "water");
    const air = draw.place("vent", 60, 300, { props: { to: "Atmosphere" } });
    draw.join([injector, "b"], [air, "in"], "water");
    return draw.drawing;
}

/**
 * A pressurized flow: a nitrogen bottle through a regulator and the press manifold into the tank's ullage (heated by
 * its wall), the main valve and a cavitating venturi out to the air, and a vent valve off the tank's ullage.
 */
export function pressurizedFlow(): Drawing {
    const draw = builder();
    const setpoint = 300 * PSI + ATMOSPHERE;
    const bottle = draw.place("bottle", -320, -300, {
        tag: "B-1",
        props: { fluid: "gn2", volume: "49 L" },
        sim: settings({ pressure: 2000 * PSI + ATMOSPHERE }, "supply"),
    });
    const regulator = draw.place("regulator", -200, -380, { tag: "REG-1", sim: settings({ setpoint, cda: 4e-6 }) });
    draw.join([bottle, "top"], [regulator, "a"], "gn2");
    const manifold = draw.place("junction", -80, -380);
    // The press manifold's tubing, at the regulator's set pressure before the test: its lines keep its settings.
    const press = { line: null, node: { pressure: setpoint } };
    draw.join([regulator, "b"], [manifold, "c"], "gn2", press);
    const pressPressure = draw.place("pressure-transducer", -80, -460, { tag: "PT-PRESS" });
    draw.join([pressPressure, "bottom"], [manifold, "c"], "gn2", press);
    const pressValve = draw.place("solenoid-valve", 0, -300, {
        turn: 90,
        tag: "SV-PRESS",
        sim: settings({ cda: 2e-5 }),
    });
    draw.join([manifold, "c"], [pressValve, "a"], "gn2", press);
    const tank = draw.place("tank", 0, -140, {
        tag: "TK-1",
        props: { fluid: "water", volume: "20 L" },
        sim: settings({ mode: "ullage", pressure: setpoint, volume: 0.02, liquid_volume: 0.015 }),
    });
    draw.join([pressValve, "b"], [tank, "top"], "gn2");
    const tankPressure = draw.place("pressure-transducer", 80, -170, { tag: "PT-TANK" });
    draw.join([tank, "right-upper"], [tankPressure, "left"], "gn2");
    const vent = draw.place("solenoid-valve", -100, -110, {
        turn: "flip",
        tag: "SV-VENT",
        props: { normal: "NO" },
        sim: settings({ cda: 5e-6, check: "no", position: 0 }),
    });
    draw.join([tank, "left-upper"], [vent, "a"], "gn2");
    const stack = draw.place("vent", -180, -110, { turn: "flip", props: { to: "Atmosphere" } });
    draw.join([vent, "b"], [stack, "in"], "gn2");
    const main = draw.place("pneumatic-valve", 0, 60, { turn: 90, tag: "MOV-01", sim: settings({ cda: 8e-5 }) });
    draw.join([tank, "bottom"], [main, "a"], "water");
    const venturi = draw.place("cavitating-venturi", 0, 160, { turn: 90, tag: "CAV-1" });
    draw.join([main, "b"], [venturi, "a"], "water");
    const air = draw.place("vent", 60, 240, { props: { to: "Atmosphere" } });
    draw.join([venturi, "b"], [air, "in"], "water");
    return draw.drawing;
}

/** Vespula's run's data: the name it's uploaded to Yorg under, the file it's in, and when it ends (s). */
export const VESPULA_RUN = { test: "Vespula prop system (FullFlow run)", file: "Vespula prop system.csv", end: 21.3 };

/**
 * Vespula's propulsion system, as Saaketh Ramoju's FullFlow model has it (github.com/saakethramoju/Vespula,
 * VESPULA_PROP_SYSTEM.py and VESPULA_DATA.py): a 40 L nitrogen COPV pressing the fuel and LOX tanks through lo-flow
 * orifices, and through hi-flow valves once it's below 2500 psia; each tank's relief valve; and each side's system
 * orifice, manifold, and injector into the chamber. Its instruments, valves, and flow meters name the channels of that
 * model's run (vespula-run.csv, the run its repository's prop curves came from, made again with FullFlow 2.0.3 to have
 * every channel): the hi-flow switches and relief valves drive their valves, the chamber's pressure is the engine's, and
 * the rest is compared. Built of the same FullFlow components with the same ThermoProp properties (real nitrogen, LOX,
 * and RP-1), a transient run of it at 0.1 s steps is that run again: every pressure, temperature, and flow to a few
 * parts in a million.
 */
export function vespula(): Drawing {
    const draw = builder();
    const copv = draw.place("copv", 0, -340, {
        tag: "COPV",
        props: { fluid: "gn2", volume: "40 L" },
        // Vespula's COPV trades no heat with its wall.
        sim: settings({ volume: 0.04, pressure: 4200 * PSI, temperature: 298.15, heat_transfer: 0 }, "vessel"),
    });
    const header = draw.place("junction", 0, -420);
    draw.join([copv, "top"], [header, "c"], "gn2");
    const copvPressure = draw.place("pressure-transducer", -80, -420, {
        tag: "PT-COPV",
        props: { channel: "COPV Pressure" },
    });
    draw.join([copvPressure, "right"], [header, "c"], "gn2");
    const copvTemperature = draw.place("thermocouple", 80, -420, {
        tag: "TC-COPV",
        props: { channel: "COPV Temperature" },
    });
    draw.join([copvTemperature, "left"], [header, "c"], "gn2");
    const chamber = draw.place("engine", 0, 460, {
        tag: "ENG-1",
        props: { propellants: "LOX/RP-1" },
        sim: settings({ pressure: 285 * PSI }),
    });
    const chamberPressure = draw.place("pressure-transducer", 100, 440, {
        tag: "PT-CHAMBER",
        props: { channel: "Chamber Pressure" },
    });
    draw.join([chamber, "right"], [chamberPressure, "left"], "combustion");

    /** One side: its tank, pressed from the COPV, and its feed into the chamber. Fuel's on the left, LOX's right. */
    const side = (
        name: "Fuel" | "LOX",
        fluid: string,
        tank: PartSim["settings"],
        cdas: { lo: number; hi: number; relief: number; system: number; injector: number },
    ) => {
        const way = name === "Fuel" ? -1 : 1;
        const x = 260 * way;
        const short = name.toUpperCase();
        const top = draw.place("junction", x, -320);
        draw.join([header, "c"], [top, "c"], "gn2");
        const switched = (cda: number, channel: string) =>
            ({ props: { channel, normal: "NC" }, sim: settings({ cda, opening_time: 0.001, position: 0 }) }) as const;
        const lo = draw.place("orifice", x - 40 * way, -260, {
            turn: 90,
            tag: `OR-${short}-LO`,
            sim: settings({ cda: cdas.lo }),
        });
        const hi = draw.place("solenoid-valve", x + 40 * way, -260, {
            turn: 90,
            tag: `SV-${short}-HF`,
            ...switched(cdas.hi, `${name} Hi Flow Switch`),
        });
        const bottom = draw.place("junction", x, -190);
        draw.join([top, "c"], [lo, "a"], "gn2");
        draw.join([top, "c"], [hi, "a"], "gn2");
        draw.join([lo, "b"], [bottom, "c"], "gn2");
        draw.join([hi, "b"], [bottom, "c"], "gn2");
        const vessel = draw.place("tank", x, -80, {
            tag: `TK-${short}`,
            props: { fluid },
            sim: settings({
                mode: "ullage",
                gas: "Nitrogen",
                gas_model: "real",
                gas_temperature: 298.15,
                heat_transfer: 0, // Vespula's ullages trade no heat with their walls
                collapse_factor: 1.2,
                ...tank,
            }),
        });
        draw.join([bottom, "c"], [vessel, "top"], "gn2");
        const ullage = draw.place("thermocouple", x - 60 * way, -190, {
            tag: `TC-${short}-ULLAGE`,
            props: { channel: `${name} Ullage Temperature` },
        });
        draw.join([ullage, way < 0 ? "left" : "right"], [bottom, "c"], "gn2");
        const pressure = draw.place("pressure-transducer", x - 80 * way, -110, {
            tag: `PT-${short}-TANK`,
            props: { channel: `${name} Tank Pressure` },
        });
        draw.join([vessel, way < 0 ? "right-upper" : "left-upper"], [pressure, way < 0 ? "left" : "right"], "gn2");
        const relief = draw.place("relief-valve", x + 120 * way, -150, {
            turn: way < 0 ? "flip" : 0,
            tag: `RV-${short}`,
            ...switched(cdas.relief, `${name} Relief Valve`),
        });
        draw.join([vessel, way < 0 ? "left-upper" : "right-upper"], [relief, "in"], "gn2");
        const out = draw.place("vent", x + 200 * way, -150, {
            turn: way < 0 ? "flip" : 0,
            props: { to: "Atmosphere" },
        });
        draw.join([relief, "out"], [out, "in"], "gn2");
        const system = draw.place("orifice", x, 40, {
            turn: 90,
            tag: `OR-${short}-SYS`,
            sim: settings({ cda: cdas.system }),
        });
        draw.join([vessel, "bottom"], [system, "a"], fluid);
        const manifold = draw.place("junction", x, 120);
        draw.join([system, "b"], [manifold, "c"], fluid);
        const manifoldPressure = draw.place("pressure-transducer", x + 80 * way, 120, {
            tag: `PT-${short}-MAN`,
            props: { channel: `${name} Manifold Pressure` },
        });
        draw.join([manifoldPressure, way < 0 ? "right" : "left"], [manifold, "c"], fluid);
        const injector = draw.place("orifice", x, 200, {
            turn: 90,
            tag: `INJ-${short}`,
            sim: settings({ cda: cdas.injector }),
        });
        draw.join([manifold, "c"], [injector, "a"], fluid);
        const meter = draw.place("flow-meter", x, 280, {
            turn: 90,
            tag: `FM-${short}`,
            props: { channel: `${name} Injector Mass Flow` },
        });
        draw.join([injector, "b"], [meter, "a"], fluid);
        draw.join([meter, "b"], [chamber, name === "Fuel" ? "fuel" : "ox"], fluid);
    };
    side(
        "Fuel",
        "rp1", // ThermoProp's RP-1 propellant, as Vespula's
        { fluid: "RP1", temperature: 298.15, pressure: 416 * PSI, volume: 0.05976, liquid_volume: 0.05211 },
        {
            lo: 0.002507537 * IN2,
            hi: 0.003124906 * IN2,
            relief: 0.0769 * IN2,
            system: 0.633 * CM2,
            injector: 0.555 * CM2,
        },
    );
    side(
        "LOX",
        "lox",
        { fluid: "Oxygen", temperature: 100, pressure: 357 * PSI, volume: 0.08582, liquid_volume: 0.07697 },
        {
            lo: 0.005460362 * IN2,
            hi: 0.006515668 * IN2,
            relief: 0.08942 * IN2,
            system: 1.51 * CM2,
            injector: 1.25 * CM2,
        },
    );
    return draw.drawing;
}
