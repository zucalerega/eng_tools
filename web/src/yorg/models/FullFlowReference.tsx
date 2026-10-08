// The Models page's Reference: what FullFlow is, how it models a system and solves it, how Yorg's parts become its
// components, and what a model's script (the Script view) is made of. Background, not a list of all FullFlow can do.

export const FULLFLOW = "https://github.com/saakethramoju/FullFlow";
export const THERMOPROP = "https://github.com/saakethramoju/ThermoProp";

const PARTS: [string, string][] = [
    ["Tank at a pressure", "its pressure, following its channel; its liquid, a Lookup of ThermoProp's"],
    [
        "Tank with an ullage",
        "a Volume of liquid and a Volume of gas, which a Balance holds at one pressure; its wall a Solid, and Convection between it and the gas",
    ],
    ["Junction", "a Volume with no room: what flows in flows out"],
    ["Gas junction", "a Volume: the gas in the tubing around it"],
    ["Gas supply, outlet", "its pressure (and temperature), following its channels"],
    ["Line", "DarcyWeisbach: friction, and the inertia of the liquid in it"],
    ["Valve, orifice", "DischargeCoefficient; a valve's Actuator moves it to its command"],
    ["Cavitating venturi", "CavitatingVenturi"],
    ["Gas valve, gas orifice", "CompressibleOrifice: choked or not"],
    ["Regulator", "CompressibleOrifice, opened as far as the pressure it holds puts it"],
];

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
    version: string | null; // FullFlow's, as the server runs it
    onClose: () => void;
}

export function FullFlowReference({ version, onClose }: Props) {
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
                Anchoring uses FullFlow&apos;s sensors. A sensor adds one balance, the model&apos;s reading less what
                its channel measured, and frees one knob for the solver to move to meet it, in every time step: the
                knob&apos;s history is what the model needed to read what was measured. A fit instead runs the whole
                model again and again, turning its knobs until the runs match the test best.
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

            <h3>Parts as components</h3>
            <table className="dev-reference-table">
                <thead>
                    <tr>
                        <th>Part</th>
                        <th>In FullFlow</th>
                    </tr>
                </thead>
                <tbody>
                    {PARTS.map(([part, components]) => (
                        <tr key={part}>
                            <td>{part}</td>
                            <td>{components}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="muted">
                Every part is made of FullFlow&apos;s own components. Yorg adds only what joins a model to a test:
                putting the test&apos;s channels in, anchoring knobs to them, and reading the results out.
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
                the first time; and it runs several times slower than on the server. Fit… and Anchor… run the
                P&amp;ID&apos;s model on the server.
            </p>
        </aside>
    );
}
