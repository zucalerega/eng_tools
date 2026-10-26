import { useMemo, useState } from "react";
import { formatValue } from "../../scale";
import type { Samples, TestDetail } from "../testdata";
import type { Catalog, Liquid, Quantity, RunResult, SystemModel } from "./api";
import { Chart, type ChartSeries } from "./Chart";
import { kindOfType, linkWords } from "./model";
import { comparisons, partOf } from "./settings";
import { channelToSiLinear, siToDisplayLinear, toDisplay, unitOf, type Linear } from "./units";

// A run against a test: what it started from (values taken from channels at its start), each channel the model is
// compared with, plotted with the model's value and how far apart they are (RMS and bias, over the run); an anchored
// run's knobs, through it; and any other value the model has, to add. Each plot's cursor reads the values at a time,
// and a click goes there on the timeline, where the drawing shows them.

export const MEASURED = "#2f7ed8";
export const MODELED = "#e0a500";
const ANCHORED = "#3aa655";

export interface Fit {
    rms: number;
    bias: number;
    count: number;
}

/** How far the model is from what was measured: at each measured sample in the window (both in the same units), the
 * model's value between its points. */
export function fitOf(
    measured: { times: ArrayLike<number>; values: ArrayLike<number> },
    model: { times: ArrayLike<number>; values: ArrayLike<number> },
): Fit | null {
    const start = model.times[0];
    const end = model.times[model.times.length - 1];
    if (start === undefined || end === undefined) {
        return null;
    }
    let sum = 0;
    let squares = 0;
    let count = 0;
    let at = 0;
    const step = Math.max(1, Math.floor(measured.times.length / 20000)); // plenty for an average
    for (let i = 0; i < measured.times.length; i += step) {
        const t = measured.times[i]!;
        const value = measured.values[i]!;
        if (t < start || t > end || Number.isNaN(value)) {
            continue;
        }
        while (at < model.times.length - 2 && model.times[at + 1]! < t) {
            at += 1;
        }
        const t0 = model.times[at]!;
        const t1 = model.times[at + 1] ?? t0;
        const y0 = model.values[at]!;
        const y1 = model.values[at + 1] ?? y0;
        if (Number.isNaN(y0) || Number.isNaN(y1)) {
            continue;
        }
        const error = value - (t1 > t0 ? y0 + ((y1 - y0) * (t - t0)) / (t1 - t0) : y0);
        sum += error;
        squares += error * error;
        count += 1;
    }
    return count > 0 ? { rms: Math.sqrt(squares / count), bias: sum / count, count } : null;
}

/** Values through a linear map, a missing one (null or NaN) NaN. */
function mapped(values: ArrayLike<number | null>, { scale, offset }: Linear): Float64Array {
    return Float64Array.from({ length: values.length }, (_, index) => {
        const value = values[index];
        return value === null || value === undefined || Number.isNaN(value) ? Number.NaN : value * scale + offset;
    });
}

/** From a channel's unit to the model's units: through SI. */
function measuredLinear(quantity: Quantity, unit: string, display: SystemModel["display"]): Linear {
    const toSi = channelToSiLinear(quantity, unit, display);
    const toDisplay = siToDisplayLinear(quantity, display);
    return { scale: toSi.scale * toDisplay.scale, offset: toSi.offset * toDisplay.scale + toDisplay.offset };
}

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

interface Box {
    key: string;
    title: string;
    unit: string;
    series: ChartSeries[];
    note: string | null;
}

export function Results({
    model,
    catalog,
    result,
    test,
    samples,
    time,
    onTime,
}: {
    model: SystemModel; // as it ran
    catalog: Catalog;
    result: RunResult;
    test: TestDetail;
    samples: ReadonlyMap<string, Samples>; // the compared channels', as they've loaded
    time: number | null; // the timeline's
    onTime: (t: number) => void;
}) {
    const [extra, setExtra] = useState<string[]>([]);
    const display = model.display;
    const window: [number, number] = [result.times[0] ?? 0, result.times[result.times.length - 1] ?? 1];
    const times = useMemo(() => Float64Array.from(result.times), [result]);
    const modeled = (key: string, quantity: Quantity): ChartSeries | null => {
        const values = result.series[key];
        return values
            ? {
                  id: `${key}:model`,
                  name: "Model",
                  color: MODELED,
                  width: 2,
                  times,
                  values: mapped(values, siToDisplayLinear(quantity, display)),
              }
            : null;
    };

    const outputs = [...model.nodes, ...model.edges].flatMap((part) =>
        (kindOfType(catalog, part.type)?.outputs ?? []).map((output) => ({
            key: `${part.id}.${output.key}`,
            title: `${part.name} ${output.label.toLowerCase()}`,
            quantity: output.quantity,
        })),
    );

    const boxes: Box[] = [];
    for (const compared of comparisons(model, catalog)) {
        const channel = test.channels.find((one) => one.name === compared.channel);
        const loaded = samples.get(compared.channel);
        const unit = unitOf(compared.quantity, display);
        const series: ChartSeries[] = [];
        const measured =
            channel && loaded
                ? {
                      id: `${compared.output}:measured`,
                      name: `${channel.name} (measured)`,
                      color: MEASURED,
                      width: 1.5,
                      times: loaded.t,
                      values: mapped(loaded.v, measuredLinear(compared.quantity, channel.unit, display)),
                  }
                : null;
        if (measured) {
            series.push(measured);
        }
        const model = modeled(compared.output, compared.quantity);
        if (model) {
            series.push(model);
        }
        const fit = measured && model ? fitOf(measured, model) : null;
        boxes.push({
            key: compared.output + compared.channel,
            title: compared.name,
            unit,
            series,
            note: fit
                ? `RMS ${formatValue(Number(fit.rms.toPrecision(4)))} ${unit} · bias ${fit.bias >= 0 ? "+" : ""}${formatValue(Number(fit.bias.toPrecision(4)))} ${unit}`
                : null,
        });
    }
    // An anchored run's knobs, through it: their settings until their spans, then what the sensors asked for.
    for (const anchor of result.anchors ?? []) {
        const key = `${anchor.part}.${anchor.key}`;
        const part = partOf(model, anchor.part);
        const sensor = partOf(model, anchor.sensor);
        const values = result.anchored?.[key];
        if (!part || !values) {
            continue;
        }
        const setting = kindOfType(catalog, part.type)?.settings.find((one) => one.key === anchor.key);
        const link = sensor && kindOfType(catalog, sensor.type)?.links.find((one) => one.key === anchor.link);
        const quantity = setting?.quantity ?? "number";
        boxes.push({
            key: `anchor:${key}`,
            title: `${part.name}: ${setting?.label ?? anchor.key}, anchored to ${sensor?.name ?? anchor.sensor} ${(link?.label ?? anchor.link).toLowerCase()}`,
            unit: unitOf(quantity, display),
            series: [
                {
                    id: `${key}:anchored`,
                    name: "Anchored",
                    color: ANCHORED,
                    width: 2,
                    times,
                    values: mapped(values, siToDisplayLinear(quantity, display)),
                },
            ],
            note: null,
        });
    }
    for (const key of extra) {
        const output = outputs.find((one) => one.key === key);
        const series = output ? modeled(key, output.quantity) : null;
        if (output && series) {
            boxes.push({
                key,
                title: output.title,
                unit: unitOf(output.quantity, display),
                series: [series],
                note: null,
            });
        }
    }

    return (
        <section className="piper-sim-results" aria-label="Results">
            <p className="muted piper-small">
                {result.steps} points in {formatValue(Number(result.elapsed.toPrecision(3)))} s of computing
                {Object.entries(result.liquids).map(
                    ([tank, liquid]) => ` · ${liquidText(partOf(model, tank)?.name ?? tank, liquid)}`,
                )}
            </p>
            {result.initial.length > 0 && (
                <p className="muted piper-small">
                    Started from the test:{" "}
                    {result.initial
                        .map((one) => {
                            const part = partOf(model, one.part);
                            const link = part && kindOfType(catalog, part.type)?.links.find((at) => at.key === one.key);
                            const unit = unitOf(one.quantity, display);
                            const value = formatValue(
                                Number(toDisplay(one.quantity, one.value, display).toPrecision(5)),
                            );
                            return `${part?.name ?? one.part} ${link ? linkWords(link) : one.key} ${value}${unit ? ` ${unit}` : ""} (${one.channel})`;
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
                <p className="muted piper-small">
                    Nothing to compare with: tap a pressure transducer to a line or a tank, or put a flow meter in a
                    line, named as the test&apos;s channel. Or add one of the model&apos;s values below.
                </p>
            )}
            <div className="piper-sim-charts">
                {boxes.map((box) => (
                    <Chart
                        key={box.key}
                        title={box.title}
                        unit={box.unit}
                        series={box.series}
                        window={window}
                        time={time}
                        note={box.note}
                        onTime={onTime}
                    />
                ))}
            </div>
            <div className="piper-sim-add">
                <label className="field">
                    Add a value the model has
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
                    <button type="button" className="button-small" onClick={() => setExtra([])}>
                        Take them off
                    </button>
                )}
            </div>
        </section>
    );
}
