import { emptyDrawing, type Drawing, type Part, type Rotation } from "./drawing";
import { addPart, connect, updateLine, updatePart } from "./edit";
import { presetOf } from "./library/index";

// The example a new diagram can start from: a pressure-fed engine's feed system. Nitrogen from a bottle, through an
// isolation valve and a regulator, presses an RP-1 tank and a LOX tank through check valves; each tank feeds the
// engine through its main valve and an orifice or a cavitating venturi. Built with the editor's own changes, so it's
// drawn, tagged, and routed as anything drawn by hand is.

export function example(): Drawing {
    let drawing = emptyDrawing();
    // A part turned (or, for one that should keep its actuator on top, mirrored: "flip"), with properties of its own.
    const place = (
        preset: string,
        x: number,
        y: number,
        turn: Rotation | "flip" = 0,
        props: Record<string, string> = {},
    ): string => {
        const added = addPart(drawing, presetOf(preset)!, { x, y });
        drawing = updatePart(added.drawing, added.id, (part: Part) => ({
            ...part,
            rotation: turn === "flip" ? 0 : turn,
            flip: turn === "flip",
            props: { ...part.props, ...props },
        }));
        return added.id;
    };
    const join = (
        from: [string, string],
        to: [string, string] | { line: string; x: number; y: number },
        fluid?: string,
    ) => {
        const target = "line" in to ? { line: to.line, at: { x: to.x, y: to.y } } : { part: to[0], port: to[1] };
        const made = connect(drawing, { part: from[0], port: from[1] }, target);
        if (!made) {
            return "";
        }
        drawing =
            fluid === undefined ? made.drawing : updateLine(made.drawing, made.id, (line) => ({ ...line, fluid }));
        return made.id;
    };

    // Pressurant: the bottle on its side, its valve to the right.
    const bottle = place("bottle", -340, -280, 90, { volume: "49 L", meop: "4500 psi" });
    const isolation = place("ball-valve", -230, -280, 0, { normal: "NC", size: "1/4 in" });
    const regulator = place("regulator", -140, -280, 0, { set: "500 psi" });
    const tee = place("junction", 0, -280);
    join([bottle, "top"], [isolation, "a"]);
    join([isolation, "b"], [regulator, "a"]);
    const pressurant = join([regulator, "b"], [tee, "c"]);
    const pressure = place("pressure-transducer", -60, -340, 0, { range: "0-1000 psi" });
    join([pressure, "bottom"], { line: pressurant, x: -60, y: -280 });

    // The tanks, each pressed through a check valve.
    const fuel = place("tank", -120, -60, 0, { fluid: "rp1", volume: "6 L", meop: "750 psi" });
    const ox = place("tank", 120, -60, 0, { fluid: "lox", volume: "6 L", meop: "750 psi" });
    const fuelCheck = place("check-valve", -120, -180, 90);
    const oxCheck = place("check-valve", 120, -180, 90);
    join([tee, "c"], [fuelCheck, "a"]);
    join([tee, "c"], [oxCheck, "a"]);
    join([fuelCheck, "b"], [fuel, "top"]);
    join([oxCheck, "b"], [ox, "top"]);
    const fuelPressure = place("pressure-transducer", -210, -90);
    const oxPressure = place("pressure-transducer", 210, -90);
    join([fuel, "left-upper"], [fuelPressure, "right"], "gn2");
    join([ox, "right-upper"], [oxPressure, "left"], "gn2");

    // The LOX tank's vent: a solenoid, open until it's powered, out to the air.
    const vent = place("solenoid-valve", 40, -90, "flip", { normal: "NO" });
    const out = place("vent", -30, -90, "flip");
    join([ox, "left-upper"], [vent, "a"], "gox");
    join([vent, "b"], [out, "in"], "gox");

    // The feeds: each tank's main valve, then what sets its flow, into the engine.
    const engine = place("engine", 0, 300, 0, { thrust: "500 lbf", pc: "300 psi", propellants: "LOX/RP-1" });
    const fuelMain = place("pneumatic-valve", -120, 60, 90);
    const oxMain = place("pneumatic-valve", 120, 60, 90);
    const orifice = place("orifice", -120, 140, 90, { diameter: "0.070 in" });
    const venturi = place("cavitating-venturi", 120, 140, 90, { throat: "0.089 in" });
    join([fuel, "bottom"], [fuelMain, "a"]);
    join([fuelMain, "b"], [orifice, "a"]);
    join([orifice, "b"], [engine, "fuel"]);
    join([ox, "bottom"], [oxMain, "a"]);
    join([oxMain, "b"], [venturi, "a"]);
    join([venturi, "b"], [engine, "ox"]);
    const chamber = place("pressure-transducer", 80, 280, 0, { range: "0-500 psi" });
    join([engine, "right"], [chamber, "left"]);

    place("legend", -300, 330);
    place("title-block", 240, 420, 0, { number: "YJSP-PID-001" });
    return drawing;
}
