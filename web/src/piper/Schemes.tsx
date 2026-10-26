import { useEffect, useState } from "react";
import { Dialog, Notice, Time } from "../components";
import { useSession } from "../session";
import { piper, type Scheme, type SchemeBody } from "./api";
import { STANDARD_FLUIDS } from "./fluids";

// The team's color schemes (/piper/schemes): each one's fluids, as lines and tanks are drawn in them, and the colors of
// valves' states. Anyone makes and changes them; an admin picks the team's default, which new diagrams start with. A
// diagram takes a scheme's colors from its own panel (with nothing selected), and is told when the scheme changes.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Piper's own colors, for a scheme made from nothing. */
const PIPER_COLORS: SchemeBody = {
    name: "New scheme",
    fluids: STANDARD_FLUIDS.map(({ id, name, label, color, gas }) => ({ id, name, label, color, gas })),
    states: { no: "#2e9e4f", nc: "#d64541", fip: "#5b7a99", other: "#e0a500" },
};

export function SchemesPage() {
    const { me } = useSession();
    const [schemes, setSchemes] = useState<Scheme[] | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<Scheme | null>(null);
    const [problem, setProblem] = useState<string | null>(null);

    const load = () => piper.schemes().then(setSchemes, (error: unknown) => setProblem(message(error)));
    useEffect(() => {
        void load();
    }, []);

    async function act(action: () => Promise<unknown>) {
        setProblem(null);
        try {
            await action();
            await load();
        } catch (error) {
            setProblem(message(error));
        }
    }

    async function make() {
        const base = schemes?.find((scheme) => scheme.is_default);
        const body = base ? { name: `${base.name} copy`, fluids: base.fluids, states: base.states } : PIPER_COLORS;
        await act(async () => setEditing((await piper.addScheme(body)).id));
    }

    return (
        <section className="piper-schemes">
            <div className="page-head">
                <h1 className="page-title">Color schemes</h1>
                <div className="page-actions">
                    <button type="button" className="button-primary" onClick={() => void make()}>
                        New scheme
                    </button>
                </div>
            </div>
            <p className="muted piper-lead">
                The colors the team draws its P&IDs in: each fluid's color and label, and the colors of valves' states.
                New diagrams start with the team's default; a diagram takes another's colors from its panel (with
                nothing selected), and says when the scheme it took them from has changed. Anyone can make a scheme;
                only whoever made one, or an admin, can change or delete it.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {schemes === null && !problem && <p className="muted">Loading…</p>}
            <div className="piper-scheme-list">
                {schemes?.map((scheme) =>
                    editing === scheme.id ? (
                        <SchemeEditor
                            key={scheme.id}
                            scheme={scheme}
                            onCancel={() => setEditing(null)}
                            onSave={(body) =>
                                void act(async () => {
                                    await piper.changeScheme(scheme.id, body);
                                    setEditing(null);
                                })
                            }
                        />
                    ) : (
                        <article key={scheme.id} className="piper-scheme" aria-label={scheme.name}>
                            <div className="piper-scheme-head">
                                <h2>{scheme.name}</h2>
                                {scheme.is_default && <span className="badge piper-badge-released">Team default</span>}
                            </div>
                            <SchemePreview scheme={scheme} />
                            <p className="muted piper-small">
                                {scheme.fluids.length} fluids. Changed by {scheme.updated_by?.name ?? "Piper"},{" "}
                                <Time at={scheme.updated_at} />
                            </p>
                            <div className="piper-revision-actions">
                                {scheme.can_edit && (
                                    <button
                                        type="button"
                                        className="button-small"
                                        onClick={() => setEditing(scheme.id)}
                                    >
                                        Edit
                                    </button>
                                )}
                                {me?.is_admin && !scheme.is_default && (
                                    <button
                                        type="button"
                                        className="button-small"
                                        onClick={() => void act(() => piper.makeDefault(scheme.id))}
                                    >
                                        Make it the default
                                    </button>
                                )}
                                {scheme.can_delete && (
                                    <button type="button" className="button-small" onClick={() => setDeleting(scheme)}>
                                        Delete…
                                    </button>
                                )}
                            </div>
                        </article>
                    ),
                )}
            </div>
            {deleting && (
                <Dialog
                    title={`Delete ${deleting.name}?`}
                    confirm="Delete"
                    danger
                    onConfirm={() =>
                        void act(async () => {
                            await piper.removeScheme(deleting.id);
                            setDeleting(null);
                        })
                    }
                    onCancel={() => setDeleting(null)}
                >
                    <p>Diagrams that took its colors keep them.</p>
                </Dialog>
            )}
        </section>
    );
}

/** A scheme at a glance: each fluid's line in its color with its label, and a valve in each state's color. */
function SchemePreview({ scheme }: { scheme: Pick<Scheme, "fluids" | "states"> }) {
    const shown = scheme.fluids.slice(0, 12);
    const states: [string, string][] = [
        ["NO", scheme.states.no],
        ["NC", scheme.states.nc],
        ["FIP", scheme.states.fip],
    ];
    return (
        <div className="piper-scheme-preview" aria-hidden="true">
            <svg viewBox={`0 0 260 ${Math.ceil(shown.length / 2) * 16 + 30}`} width="100%">
                {shown.map((fluid, index) => {
                    const x = (index % 2) * 130;
                    const y = Math.floor(index / 2) * 16 + 10;
                    return (
                        <g key={fluid.id}>
                            <line x1={x + 4} y1={y} x2={x + 40} y2={y} stroke={fluid.color} strokeWidth={3} />
                            <text x={x + 46} y={y + 3.5} fontSize={9} fontWeight={700} fill={fluid.color}>
                                {fluid.label || fluid.name}
                            </text>
                        </g>
                    );
                })}
                {states.map(([label, color], index) => {
                    const x = 10 + index * 60;
                    const y = Math.ceil(shown.length / 2) * 16 + 16;
                    return (
                        <g key={label}>
                            <path
                                d={`M${x} ${y - 6} L${x + 18} ${y + 6} L${x + 18} ${y - 6} L${x} ${y + 6} Z`}
                                fill={color}
                                stroke="currentColor"
                                strokeWidth={1}
                            />
                            <text x={x + 24} y={y + 3.5} fontSize={9} fill="currentColor">
                                {label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

/** A scheme's name, fluids, and states, changed and saved together. */
function SchemeEditor({
    scheme,
    onSave,
    onCancel,
}: {
    scheme: Scheme;
    onSave: (body: SchemeBody) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState(scheme.name);
    const [fluids, setFluids] = useState(scheme.fluids);
    const [states, setStates] = useState(scheme.states);
    const setFluid = (index: number, change: Partial<Scheme["fluids"][number]>) =>
        setFluids((now) => now.map((fluid, at) => (at === index ? { ...fluid, ...change } : fluid)));
    const ids = new Set(fluids.map((fluid) => fluid.id));
    const newId = () => {
        let count = 1;
        while (ids.has(`fluid-${count}`)) {
            count++;
        }
        return `fluid-${count}`;
    };
    return (
        <form
            className="piper-scheme piper-scheme-editing"
            aria-label={`Editing ${scheme.name}`}
            onSubmit={(event) => {
                event.preventDefault();
                onSave({ name: name.trim() || scheme.name, fluids, states });
            }}
        >
            <label className="field">
                Name
                <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
            </label>
            <h3 className="piper-subhead">Fluids</h3>
            <div className="piper-fluid-editor">
                {fluids.map((fluid, index) => (
                    <div key={fluid.id} className="piper-fluid-row">
                        <input
                            type="color"
                            aria-label={`${fluid.name}'s color`}
                            value={fluid.color}
                            onChange={(event) => setFluid(index, { color: event.target.value })}
                        />
                        <input
                            aria-label={`${fluid.name}'s label`}
                            className="piper-fluid-label"
                            value={fluid.label}
                            maxLength={12}
                            onChange={(event) => setFluid(index, { label: event.target.value })}
                        />
                        <input
                            aria-label={`${fluid.name}'s name`}
                            value={fluid.name}
                            maxLength={60}
                            onChange={(event) => setFluid(index, { name: event.target.value })}
                        />
                        <label className="check piper-small" title="A tank of it is full of it, not filled to a level">
                            <input
                                type="checkbox"
                                checked={fluid.gas}
                                onChange={(event) => setFluid(index, { gas: event.target.checked })}
                            />
                            Gas
                        </label>
                        <button
                            type="button"
                            className="piper-remove"
                            aria-label={`Remove ${fluid.name}`}
                            onClick={() => setFluids((now) => now.filter((_, at) => at !== index))}
                        >
                            ×
                        </button>
                    </div>
                ))}
                <button
                    type="button"
                    className="button-small"
                    onClick={() =>
                        setFluids((now) => [
                            ...now,
                            { id: newId(), name: "New fluid", label: "NEW", color: "#8c6d4e", gas: false },
                        ])
                    }
                >
                    + Add a fluid
                </button>
            </div>
            <h3 className="piper-subhead">Valve states</h3>
            <div className="piper-state-colors">
                {(
                    [
                        ["no", "Normally open"],
                        ["nc", "Normally closed"],
                        ["fip", "Fails in place"],
                        ["other", "In a test: neither open nor closed"],
                    ] as const
                ).map(([key, label]) => (
                    <label key={key} className="check">
                        <input
                            type="color"
                            value={states[key]}
                            onChange={(event) => setStates((now) => ({ ...now, [key]: event.target.value }))}
                        />
                        {label}
                    </label>
                ))}
            </div>
            <SchemePreview scheme={{ fluids, states }} />
            <div className="piper-revision-actions">
                <button type="submit" className="button-small button-primary">
                    Save
                </button>
                <button type="button" className="button-small" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
