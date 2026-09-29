import { useMemo, useState } from "react";
import type { DatasetDetail } from "../api";
import { usePlotColors } from "../colors";
import { samples as loadSamples, useLoaded } from "../data";
import type { AxisSpec } from "../layout";
import { Plot, type PlotSeries, type TimeAxis } from "../Plot";
import { Samples, sampleAt } from "../samples";
import { clockTicks, formatClock, formatTick, formatValue, ticks } from "../scale";
import type { Catalog, Liquid, Quantity, RunResult, SystemModel } from "./api";
import { channelPlacement, comparisons, kindOf, modelPlacement } from "./model";
import { toDisplay, unitOf } from "./units";

// A run against a test: what it started from (values taken from channels at its start), each channel the model is
// compared with, plotted with the model's value, with how far apart they are (RMS and bias, over the run); and any
// other output the model has, to add. The plots share their window (drag to zoom, as in Yorg's workspace) and cursor,
// and read from T0 when the dataset has one.

const MEASURED = "#2f7ed8";
const MODELED = "#e0a500";

export interface Fit {
    rms: number;
    bias: number;
    count: number;
}

/** How far a model's output is from what was measured, at each measured sample in the run (both in the same units). */
export function fitOf(
    measured: Samples,
    measuredScale: number,
    measuredOffset: number,
    times: number[],
    model: (number | null)[],
    modelScale: number,
    modelOffset: number,
): Fit | null {
    const start = times[0];
    const end = times[times.length - 1];
    if (start === undefined || end === undefined) {
        return null;
    }
    let sum = 0;
    let squares = 0;
    let count = 0;
    let at = 0;
    const step = Math.max(1, Math.floor(measured.length / 20000)); // plenty for an average
    for (let i = 0; i < measured.length; i += step) {
        const t = measured.times[i]!;
        const value = measured.values[i]!;
        if (t < start || t > end || Number.isNaN(value)) {
            continue;
        }
        while (at < times.length - 2 && times[at + 1]! < t) {
            at += 1;
        }
        const t0 = times[at]!;
        const t1 = times[at + 1] ?? t0;
        const y0 = model[at];
        const y1 = model[at + 1] ?? y0;
        if (y0 === null || y0 === undefined || y1 === null || y1 === undefined) {
            continue;
        }
        const modeled = (t1 > t0 ? y0 + ((y1 - y0) * (t - t0)) / (t1 - t0) : y0) * modelScale + modelOffset;
        const error = value * measuredScale + measuredOffset - modeled;
        sum += error;
        squares += error * error;
        count += 1;
    }
    return count > 0 ? { rms: Math.sqrt(squares / count), bias: sum / count, count } : null;
}

function modelSamples(result: RunResult, key: string): Samples | null {
    const values = result.series[key];
    return values
        ? new Samples(
              Float64Array.from(result.times),
              Float64Array.from(values, (value) => value ?? Number.NaN),
          )
        : null;
}

interface PlotBox {
    key: string;
    title: string;
    unit: string;
    series: (PlotSeries & { name: string })[];
    fit: Fit | null;
}

const MINUS = "\u2212";

/** A tank's liquid, as it was in the run: at a temperature, or following a channel's over a range. */
function liquidText(name: string, liquid: Liquid): string {
    const range = (values: [number, number] | undefined, unit: string) =>
        values && values[1] - values[0] > 1e-6
            ? `${formatValue(values[0])}–${formatValue(values[1])} ${unit}`
            : `${formatValue(values?.[0] ?? 0)} ${unit}`;
    if (liquid.follows && liquid.temperatures && liquid.densities) {
        return `${name}: ${liquid.fluid} following ${liquid.follows}, ${range(liquid.temperatures, "K")}, ${range(liquid.densities, "kg/m³")}`;
    }
    return `${name}: ${liquid.fluid} at ${formatValue(liquid.temperature)} K, ${formatValue(liquid.density)} kg/m³`;
}

export function Results({
    model,
    catalog,
    result,
    detail,
    zero = null,
}: {
    model: SystemModel;
    catalog: Catalog;
    result: RunResult;
    detail: DatasetDetail;
    zero?: number | null; // the dataset's T0, if it has one here
}) {
    useLoaded(); // redraw as measured channels load
    const colors = usePlotColors();
    const span: [number, number] = [result.times[0] ?? 0, result.times[result.times.length - 1] ?? 1];
    const [window, setWindow] = useState<[number, number] | null>(null);
    const [cursor, setCursor] = useState<number | null>(null);
    const [extra, setExtra] = useState<string[]>([]);
    const display = model.display;
    const shown = window ?? span;

    const time: TimeAxis = useMemo(() => {
        if (zero !== null) {
            return {
                ticks: (from, to, count) => {
                    const found = ticks(from - zero, to - zero, count);
                    return { values: found.values.map((value) => value + zero), step: found.step };
                },
                label: (x, step) => {
                    const t = x - zero;
                    return Math.abs(t) < 1e-9 ? "T0" : `T${t < 0 ? MINUS : "+"}${formatTick(Math.abs(t), step)}`;
                },
            };
        }
        return detail.time_kind === "clock"
            ? { ticks: clockTicks, label: (x, step) => formatClock(x, step) }
            : { ticks, label: (x, step) => formatTick(x, step) };
    }, [detail.time_kind, zero]);

    const outputs = [...model.nodes, ...model.edges].flatMap((part) =>
        kindOf(catalog, part.type).outputs.map((output) => ({
            key: `${part.id}.${output.key}`,
            title: `${part.name} ${output.label.toLowerCase()}`,
            quantity: output.quantity as Quantity,
        })),
    );

    const boxes: PlotBox[] = [];
    for (const compared of comparisons(model, catalog)) {
        const channel = detail.channels.find((one) => one.name === compared.channel);
        const modeled = modelSamples(result, compared.output);
        const placement = modelPlacement(compared.quantity, display);
        const series: PlotBox["series"] = [];
        let fit: Fit | null = null;
        if (channel) {
            const loaded = loadSamples(detail, channel);
            const measuredPlacement = channelPlacement(compared.quantity, channel.unit, display);
            const measured = loaded.status === "ready" ? loaded.value : null;
            series.push({
                id: `${compared.output}:measured`,
                name: `${channel.name} (measured)`,
                color: MEASURED,
                width: 1.5,
                step: false,
                axis: "a",
                samples: measured,
                placement: measuredPlacement,
                unit: unitOf(compared.quantity, display),
                labels: null,
            });
            if (measured && result.series[compared.output]) {
                fit = fitOf(
                    measured,
                    measuredPlacement.scale,
                    measuredPlacement.offset,
                    result.times,
                    result.series[compared.output]!,
                    placement.scale,
                    placement.offset,
                );
            }
        }
        if (modeled) {
            series.push({
                id: `${compared.output}:model`,
                name: "Model",
                color: MODELED,
                width: 2,
                step: false,
                axis: "a",
                samples: modeled,
                placement,
                unit: unitOf(compared.quantity, display),
                labels: null,
            });
        }
        boxes.push({
            key: compared.output + compared.channel,
            title: compared.name,
            unit: unitOf(compared.quantity, display),
            series,
            fit,
        });
    }
    for (const key of extra) {
        const output = outputs.find((one) => one.key === key);
        const modeled = modelSamples(result, key);
        if (!output || !modeled) {
            continue;
        }
        const unit = unitOf(output.quantity, display);
        const series = [
            {
                id: `${key}:model`,
                name: "Model",
                color: MODELED,
                width: 2,
                step: false,
                axis: "a",
                samples: modeled,
                placement: modelPlacement(output.quantity, display),
                unit,
                labels: null,
            },
        ];
        boxes.push({ key, title: output.title, unit, series, fit: null });
    }

    const axes: AxisSpec[] = [{ id: "a", side: "left", label: "", min: null, max: null }];
    const nothing = () => {};
    return (
        <section className="dev-results" aria-label="Results">
            <p className="muted">
                {result.steps} points in {formatValue(result.elapsed)} s of computing
                {Object.entries(result.liquids).map(([tank, liquid]) => {
                    const name = model.nodes.find((node) => node.id === tank)?.name ?? tank;
                    return ` · ${liquidText(name, liquid)}`;
                })}
            </p>
            {result.initial.length > 0 && (
                <p className="muted dev-started">
                    Started from the test:{" "}
                    {result.initial
                        .map((one) => {
                            const part = [...model.nodes, ...model.edges].find((found) => found.id === one.part);
                            const link =
                                part && kindOf(catalog, part.type).links.find((found) => found.key === one.key);
                            const unit = unitOf(one.quantity, display);
                            const value = formatValue(toDisplay(one.quantity, one.value, display));
                            return `${part?.name ?? one.part} ${(link?.label ?? one.key).toLowerCase()} ${value}${unit ? ` ${unit}` : ""} (${one.channel})`;
                        })
                        .join(" · ")}
                </p>
            )}
            {result.notes.map((note) => (
                <p key={note} className="notice notice-warning">
                    {note}
                </p>
            ))}
            {boxes.length === 0 && (
                <p className="muted">
                    Link a sensor (a junction's pressure transducer, a flow meter) to a channel to compare the model
                    with it, or add an output below.
                </p>
            )}
            {boxes.map((box) => {
                const readouts = new Map(
                    box.series.map(
                        (one) =>
                            [
                                one.id,
                                cursor === null || !one.samples ? null : sampleAt(one.samples, cursor, one.placement),
                            ] as const,
                    ),
                );
                return (
                    <div key={box.key} className="dev-plot">
                        <div className="dev-legend">
                            <strong>{box.title}</strong>
                            {box.series.map((one) => {
                                const point = readouts.get(one.id);
                                return (
                                    <span key={one.id} className="dev-swatch">
                                        <i style={{ background: one.color }} />
                                        {one.name}
                                        {point && ` ${formatValue(point.y)} ${box.unit}`}
                                    </span>
                                );
                            })}
                            {box.fit && (
                                <span className="dev-fit" title={`Over ${box.fit.count} measured samples in the run`}>
                                    RMS {formatValue(box.fit.rms)} {box.unit} · bias {box.fit.bias >= 0 ? "+" : ""}
                                    {formatValue(box.fit.bias)} {box.unit}
                                </span>
                            )}
                        </div>
                        <Plot
                            label={box.title}
                            series={box.series}
                            axes={axes}
                            height={200}
                            window={shown}
                            time={time}
                            marks={[]}
                            shading={[]}
                            cursor={cursor}
                            readouts={readouts}
                            gutters={{ left: 1, right: 0 }}
                            colors={colors}
                            onCursor={setCursor}
                            onWindow={(next) => setWindow(next)}
                            onAxis={nothing}
                            onMenu={nothing}
                            notes={[]}
                            placing={false}
                            onPlace={nothing}
                            measure={null}
                            onNote={nothing}
                            onEditNote={nothing}
                            onMoveMark={nothing}
                        />
                    </div>
                );
            })}
            <label className="field dev-add-output">
                Add an output
                <select
                    value=""
                    onChange={(event) =>
                        event.target.value &&
                        setExtra([...extra.filter((key) => key !== event.target.value), event.target.value])
                    }
                >
                    <option value="">Pick one</option>
                    {outputs
                        .filter((output) => !extra.includes(output.key) && result.series[output.key])
                        .map((output) => (
                            <option key={output.key} value={output.key}>
                                {output.title}
                            </option>
                        ))}
                </select>
            </label>
            {extra.length > 0 && (
                <p>
                    <button type="button" className="button-small" onClick={() => setExtra([])}>
                        Remove the added outputs
                    </button>
                </p>
            )}
        </section>
    );
}
