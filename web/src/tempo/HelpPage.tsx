import { getPinnedBaseline } from "./compatibility";
import { Link } from "../router";

export function HelpPage() {
    const baseline = getPinnedBaseline();
    return (
        <div className="tempo-page tempo-help-page">
            <header className="tempo-page-head">
                <div>
                    <h1>Tempo Help</h1>
                    <p className="muted">Luna Sequence Simulator — operator guide and compatibility notes</p>
                </div>
                <Link to="/tempo" className="button-primary">
                    Back to workspace
                </Link>
            </header>

            <section className="tempo-help-section">
                <h2>What Tempo does</h2>
                <p>
                    Tempo validates and simulates YJSP Luna Python sequences entirely inside an isolated browser sandbox
                    (Pyodide WebAssembly). Operator Python never executes on the Engineering Tools server.
                </p>
                <p>
                    Tempo preserves your exact Python source without rewriting or auto-fixing it, so exported{" "}
                    <code>.py</code> files can be used directly in Luna&apos;s GUI or server.
                </p>
            </section>

            <section className="tempo-help-section">
                <h2>Validation checks</h2>
                <ul>
                    <li>
                        <strong>Python syntax:</strong> Checks syntax and indentation without altering your code.
                    </li>
                    <li>
                        <strong>Names &amp; imports:</strong> Flags undefined devices, missing imports, and disallowed
                        stdlib modules that are unavailable in Luna&apos;s sequence runner.
                    </li>
                    <li>
                        <strong>Luna API &amp; mappings:</strong> Verifies calls against Luna&apos;s extracted Python
                        API (<code>Valve</code>, <code>Sensor</code>, <code>wait_for</code>, <code>wait_until</code>,
                        abort stages, engineering units), rejects deterministic portability failures (such as unbounded{" "}
                        <code>wait_until()</code> without a finite timeout), and emits explicit warnings for dynamic or
                        partially verified code.
                    </li>
                    <li>
                        <strong>Simulated runtime:</strong> Executes the sequence against your configured valves and
                        sensors with a virtual clock (1× or 5×) and abort-stage monitoring.
                    </li>
                </ul>
            </section>

            <section className="tempo-help-section">
                <h2>Luna API baseline</h2>
                <p>
                    Tempo&apos;s compatibility and simulation engine is pinned to Sequence Tester{" "}
                    <code>{baseline.tester_sha.slice(0, 8)}</code> and tested against Luna{" "}
                    <code>{baseline.luna_sha.slice(0, 8)}</code>.
                </p>
                <p>
                    <strong>Simulation ≠ hardware verification.</strong> Passing a simulation in Tempo does not certify
                    that a sequence is safe or approved for physical hardware, SAM communication, or flight operations.
                </p>
            </section>
        </div>
    );
}
