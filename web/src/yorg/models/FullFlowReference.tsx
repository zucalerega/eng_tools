import type { Catalog } from "./api";
import { kindOf, shownSettings } from "./model";

// The Models page's Reference: what FullFlow is, how each of Yorg's parts is built of its components (as the server's
// script.py writes them), how it models a system and solves it, and what a model's script (the Script view) is made
// of. Background, not a list of all FullFlow can do.

export const FULLFLOW = "https://github.com/saakethramoju/FullFlow";
export const THERMOPROP = "https://github.com/saakethramoju/ThermoProp";

/** A part as FullFlow has it: its type in the catalog, set up as (an ullage tank, a vessel), for the knobs it has. */
const BUILT: { part: string; type: string; when?: Record<string, string>; how: string }[] = [
    {
        part: "Tank, at a fixed pressure",
        type: "tank",
        when: { mode: "fixed" },
        how: "Its pressure is a state that follows its channel through the run, or stays where it's set. Its liquid's density and vapor pressure come from ThermoProp through a Lookup, at each node's pressure and the liquid's temperature.",
    },
    {
        part: "Tank, with a gas ullage",
        type: "tank",
        when: { mode: "ullage" },
        how: "Two Volumes, its liquid and the ullage's gas over it, which a Balance holds at one pressure: the ullage is the tank's volume less the liquid's. Its wall is a Solid trading heat with the gas by Convection, the wall hA being the coefficient times the area. Pressurant flowing in is divided by the collapse factor before it counts as gas.",
    },
    {
        part: "Gas supply",
        type: "source",
        how: "Its pressure and temperature follow their channels, or stay where they're set; its gas is ThermoProp's at them, or an ideal gas.",
    },
    {
        part: "Junction",
        type: "junction",
        how: "A Volume with no room: FullFlow solves its pressure so that what flows in flows out.",
    },
    {
        part: "Gas junction",
        type: "gas_junction",
        when: { wall: "vessel" },
        how: "A Volume of gas, whose mass and energy FullFlow keeps as it solves the gas's pressure and temperature, the gas flowing in bringing the enthalpy of where it came from. Held in a vessel (a COPV, a bottle), its wall is a Solid trading heat with the gas by Convection, as an ullage's.",
    },
    {
        part: "Outlet",
        type: "outlet",
        how: "Its pressure follows its channel (a chamber's), or stays where it's set.",
    },
    {
        part: "Line",
        type: "line",
        how: "DarcyWeisbach: friction over its length and inner diameter, with the fittings' K folded in as f + K·D/L. Its flow is a dynamic state, so the liquid in it has inertia.",
    },
    {
        part: "Valve",
        type: "valve",
        how: "DischargeCoefficient: its CdA times its position, which an Actuator moves toward its command channel no faster than its opening time allows.",
    },
    {
        part: "Orifice",
        type: "orifice",
        how: "DischargeCoefficient: its CdA, fixed.",
    },
    {
        part: "Cavitating venturi",
        type: "venturi",
        how: "CavitatingVenturi: its throat CdA, and the pressure recovery that decides when it cavitates, after which its flow follows the pressure before it and the liquid's vapor pressure alone.",
    },
    {
        part: "Gas valve",
        type: "gas_valve",
        how: "CompressibleOrifice, choked or not, with the gas's gas constant and heat capacity ratio from ThermoProp where it comes from: its CdA times its position, which moves as a valve's does. As a check valve, it shuts to gas flowing back.",
    },
    {
        part: "Gas orifice",
        type: "gas_orifice",
        how: "CompressibleOrifice, as a gas valve's: its CdA, fixed.",
    },
    {
        part: "Regulator",
        type: "regulator",
        how: "CompressibleOrifice, opened from 0 to 1 as (set pressure − the pressure it holds) ÷ droop, solved with the rest of the model in each step. No gas flows back through it.",
    },
];

/** The labels of a part's knobs, set up as given (the rest at their defaults). */
function knobsOf(catalog: Catalog, type: string, when: Record<string, string> = {}): string[] {
    const kind = kindOf(catalog, type);
    const settings = { ...Object.fromEntries(kind.settings.map((setting) => [setting.key, setting.default])), ...when };
    return shownSettings(kind, settings)
        .filter((setting) => setting.tunable)
        .map((setting) => setting.label);
}

const CALLS: [string, string][] = [
    ["Run(data, start, end, dt, ...)", "The run: its network (run.net), and the test's channels, data['part.link']"],
    ["run.following(key, otherwise)", "A state that follows a channel through the run"],
    ["run.starting(key, otherwise)", "A channel's value at the run's start"],
    ["run.command(key, closed, opened, otherwise)", "A valve's command, 0 closed to 1 open"],
    ["run.liquid(tank, liquid)", "Checks ThermoProp has a tank's liquid as a liquid, for the page"],
    ["above(pressure, boiling)", "Where a junction reads its liquid: never below where it would boil"],
    ["eased(cd, upstream, downstream)", "A restriction's discharge coefficient, eased off within 500 Pa of no drop"],
    ["run.record({...})", "What the run reports, by part.output: what the page plots"],
    ["run.anchor(knob, reading, ...)", "A knob, anchored to a channel"],
    ["run.solve()", "Solve it: result is what the page shows"],
];

interface Props {
    catalog: Catalog;
    version: string | null; // FullFlow's, as the server runs it
    onClose: () => void;
}

export function FullFlowReference({ catalog, version, onClose }: Props) {
    return (
        <aside className="dev-side dev-reference" aria-label="Reference">
            <div className="dev-reference-head">
                <h2>FullFlow</h2>
                <button type="button" className="button-small" onClick={onClose}>
                    Close
                </button>
            </div>
            <p>
                <a href={FULLFLOW} target="_blank" rel="noreferrer">
                    FullFlow
                </a>{" "}
                is Saaketh Ramoju&apos;s open-source Python library for simulating fluid systems over time: feed
                systems, engines, test stands. Yorg runs it{version ? `, version ${version},` : ""} on the server, with{" "}
                <a href={THERMOPROP} target="_blank" rel="noreferrer">
                    ThermoProp
                </a>{" "}
                (Saaketh Ramoju&apos;s too) for fluids&apos; properties.
            </p>

            <h3>How each part is built</h3>
            <p>
                Each part on the P&amp;ID is made of FullFlow&apos;s own components, as the Script view writes them out:
            </p>
            <dl className="dev-reference-parts">
                {BUILT.map((one) => {
                    const knobs = knobsOf(catalog, one.type, one.when);
                    return (
                        <div key={one.part}>
                            <dt>{one.part}</dt>
                            <dd>
                                {one.how}
                                {knobs.length > 0 && <span className="muted"> Knobs: {knobs.join(", ")}.</span>}
                            </dd>
                        </div>
                    );
                })}
            </dl>
            <p className="muted">
                A restriction&apos;s discharge coefficient eases off within 500 Pa of no pressure drop, so a junction
                between a shut valve and an orifice still settles. Yorg adds two components of its own: an Anchor, a
                FullFlow Sensor that pins a knob to a channel, and a Recorder, which collects what a run reports.
            </p>

            <h3>A network of states</h3>
            <p>
                A model is a network of components joined by states. A state is one number the model tracks: a pressure,
                a temperature, a flow, a valve&apos;s position. Parts share states where they meet: a line&apos;s
                downstream pressure is the pressure of the junction it flows into.
            </p>
            <p>
                Some states are known at every moment, like a tank&apos;s measured pressure or a valve&apos;s command:
                sequences set them from the test&apos;s channels. FullFlow solves for the rest.
            </p>

            <h3>What a component says</h3>
            <p>Each component tells the solver what must hold, in one or more of three ways:</p>
            <ul>
                <li>
                    <strong>Values from others:</strong> an orifice&apos;s flow, from the pressures across it.
                </li>
                <li>
                    <strong>Balances,</strong> equations that must come out zero: what flows into a junction less what
                    flows out.
                </li>
                <li>
                    <strong>Dynamics,</strong> rates of change: the mass and energy of a tank&apos;s gas, a line&apos;s
                    flow (its inertia), a valve&apos;s travel, a wall&apos;s temperature.
                </li>
            </ul>

            <h3>Solving over time</h3>
            <p>
                A transient run steps through time. In each step, FullFlow finds the states at the step&apos;s end that
                bring every balance to zero and change everything stored by its rate over the step (implicit, or
                backward, Euler), with SciPy&apos;s least squares. Implicit steps stay stable when parts are stiff, like
                a little tubing beside a big tank. A step that won&apos;t settle is tried again in halves.
            </p>
            <p>
                A steady run is FullFlow&apos;s quasi-steady sweep: in each time step every rate is held at zero, so
                lines, junctions, and regulators settle at once. Nothing fills or drains, so tanks hold the pressure
                measured (or set), and so do gas junctions a transducer reads.
            </p>

            <h3>Matching a test</h3>
            <p>
                Tune… matches a model&apos;s knobs to a test one of two ways. Anchoring uses FullFlow&apos;s sensors: a
                sensor adds one balance, the model&apos;s reading less what its channel measured, and frees one knob for
                the solver to move to meet it, in every time step, so the knob&apos;s history is what the model needed
                to read what was measured. A fit instead runs the whole model again and again, turning its knobs until
                the runs match the test best.
            </p>

            <h3>Fluids</h3>
            <p>
                FullFlow takes a fluid&apos;s properties from anywhere: a volume is given its density, energy, and
                enthalpy as states. A model reads them from ThermoProp (CoolProp underneath) through FullFlow&apos;s
                Lookup, at each node&apos;s pressure and temperature, as Vespula&apos;s own model does.
            </p>
            <p>
                A gas is real by default: ThermoProp&apos;s at its pressure and temperature, which matters at bottle
                pressures (nitrogen at 4200 psia is 12% less dense than an ideal gas, and cools as it throttles). Set a
                gas supply&apos;s or an ullage&apos;s gas properties to ideal for pV = mRT. A liquid is its tank&apos;s,
                at each node&apos;s pressure and the tank&apos;s temperature (which follows its channel if it&apos;s
                linked); RP-1 is ThermoProp&apos;s propellant.
            </p>

            <h3>The script</h3>
            <p>
                The Script view is the model as the FullFlow code that runs it, written from the P&amp;ID: each part
                adds its components to the network, then the run solves it. Yorg&apos;s own (yorg_models) does the rest:
            </p>
            <dl className="dev-reference-calls">
                {CALLS.map(([call, what]) => (
                    <div key={call}>
                        <dt>
                            <code>{call}</code>
                        </dt>
                        <dd>{what}</dd>
                    </div>
                ))}
            </dl>
            <p>
                As it&apos;s written, Run runs it on the server. Changed, it runs in your browser: Python there, with
                FullFlow and ThermoProp installed from PyPI at the server&apos;s versions, which takes a minute or two
                the first time; and it runs several times slower than on the server. Tune… runs the P&amp;ID&apos;s
                model on the server, its fits and anchored runs alike.
            </p>
        </aside>
    );
}
