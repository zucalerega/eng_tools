import type { Units } from "./model";
import type { Reading } from "./measure";

// What's measured, over the view's corner: what's under the mouse, the one or two things picked, and what they are
// to each other. The view says what its things are (a face, an edge, or a corner in 3D; a line, an arc, or a corner on
// a drawing), and how to measure them.

/** What a picked thing is, or two to each other. */
interface Measured {
    title: string;
    readings: Reading[];
}

export function MeasurePanel<T>({
    hovering,
    picked,
    units,
    clear,
    one,
    two,
    hint,
}: {
    hovering: T | null;
    picked: T[];
    units: Units;
    clear(): void;
    one(entity: T, units: Units): Measured;
    two(first: T, second: T, units: Units): Measured;
    hint: string; // what to click
}) {
    const [first, second] = picked;
    return (
        <aside className="caliper-measure" aria-label="Measurements">
            <div className="caliper-measure-head">
                <strong>Measure</strong>
                {picked.length > 0 && (
                    <button type="button" className="button-small" onClick={clear}>
                        Clear
                    </button>
                )}
            </div>
            {picked.length === 0 && <p className="muted">{hint}</p>}
            {first && !second && <Readings measurement={one(first, units)} heading="1" />}
            {first && second && (
                <>
                    {[first, second].map((entity, i) => (
                        <p key={i} className="caliper-picked-line">
                            <span className="caliper-pick-number">{i + 1}</span>
                            {summary(one(entity, units))}
                        </p>
                    ))}
                    <Readings measurement={two(first, second, units)} result />
                </>
            )}
            {hovering && picked.length < 2 && (
                <p className="caliper-hovering muted" aria-live="polite">
                    {summary(one(hovering, units))}
                </p>
            )}
        </aside>
    );
}

/** One line for what's under the mouse: "Cylinder, diameter 6.350 mm". */
export function summary(measurement: Measured): string {
    const first = measurement.readings[0];
    return first ? `${measurement.title}, ${first.label.toLowerCase()} ${first.value}` : measurement.title;
}

function Readings({
    measurement,
    heading,
    result = false,
}: {
    measurement: Measured;
    heading?: string;
    result?: boolean;
}) {
    return (
        <section className={result ? "caliper-result" : "caliper-picked"}>
            <h3>
                {heading && <span className="caliper-pick-number">{heading}</span>}
                {measurement.title}
            </h3>
            <dl>
                {measurement.readings.map((reading) => (
                    <div key={reading.label}>
                        <dt>{reading.label}</dt>
                        <dd>{reading.value}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
