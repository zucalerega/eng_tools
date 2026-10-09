import type { Units } from "./model";
import { measureOne, measureTwo, type Entity, type Measurement } from "./measure";

// What's measured, over the view's corner: what's under the mouse, the one or two things picked, and what they are
// to each other.

export function MeasurePanel({
    hovering,
    picked,
    units,
    clear,
}: {
    hovering: Entity | null;
    picked: Entity[];
    units: Units;
    clear(): void;
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
            {picked.length === 0 && (
                <p className="muted">
                    Click a face, an edge, or a corner. Click a second to measure between them; a third starts over.
                </p>
            )}
            {first && !second && <Readings measurement={measureOne(first, units)} heading="1" />}
            {first && second && (
                <>
                    {[first, second].map((entity, i) => (
                        <p key={i} className="caliper-picked-line">
                            <span className="caliper-pick-number">{i + 1}</span>
                            {summary(measureOne(entity, units))}
                        </p>
                    ))}
                    <Readings measurement={measureTwo(first, second, units)} result />
                </>
            )}
            {hovering && picked.length < 2 && (
                <p className="caliper-hovering muted" aria-live="polite">
                    {summary(measureOne(hovering, units))}
                </p>
            )}
        </aside>
    );
}

/** One line for what's under the mouse: "Cylinder, diameter 6.350 mm". */
export function summary(measurement: Measurement): string {
    const first = measurement.readings[0];
    return first ? `${measurement.title}, ${first.label.toLowerCase()} ${first.value}` : measurement.title;
}

function Readings({
    measurement,
    heading,
    result = false,
}: {
    measurement: Measurement;
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
