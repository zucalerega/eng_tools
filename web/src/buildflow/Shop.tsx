import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type UserRef } from "../api";
import { Dialog, Notice } from "../components";
import { Link, navigate } from "../router";
import { useSession } from "../session";
import { siteName } from "../site";
import {
    buildflow,
    LEVEL_NAMES,
    RUNS_IT,
    SHOP_STATUS_NAMES,
    SHOP_STATUSES,
    type Load,
    type Machine,
    type Program,
    type ProgramDetail,
    type Shop,
    type ShopPart,
    type ShopPartChange,
    type ShopStatus,
} from "./api";

// Buildflow's shop, from the team's machining tracker (/buildflow/shop): the parts queued to be machined, how much work
// each machine has waiting, and who can run it; how far each person's trained on each machine (/buildflow/shop/skills);
// and, for admins, the machines (/buildflow/shop/machines). Anyone keeps the queue; the server keeps the rules
// (buildflow/shop.py). A part can be for a component on a program's bill of design, whose panel then shows it.

export type ShopSection = "queue" | "skills" | "machines";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const REFRESH_MS = 30_000; // the queue, as others change it, while the page is in view

/** What parts are usually made from, to offer as one's typed. */
const MATERIALS = [
    "6061-T6 aluminum",
    "7075-T6 aluminum",
    "304 stainless",
    "316 stainless",
    "17-4 PH stainless",
    "Inconel 718",
    "C101 copper",
    "Ti-6Al-4V",
    "360 brass",
    "Delrin",
    "PTFE",
    "G-10/FR-4",
    "Phenolic",
];

const hours = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, ""));

const day = (iso: string) => {
    const [year, month, date] = iso.split("-").map(Number);
    return new Date(year!, month! - 1, date!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Who can make a machine's parts: those who run it on their own, or train others on it, the most trained first. */
function canRun(shop: Shop, machine: number): UserRef[] {
    return shop.trained
        .filter((each) => (each.levels[machine] ?? 0) >= RUNS_IT)
        .sort((a, b) => (b.levels[machine] ?? 0) - (a.levels[machine] ?? 0))
        .map((each) => each.user);
}

export function ShopPage({ section }: { section: ShopSection }) {
    const { me } = useSession();
    const [shop, setShop] = useState<Shop | null>(null);
    const [members, setMembers] = useState<UserRef[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const [editing, setEditing] = useState<Draft | null>(null);

    const reload = useCallback(async () => {
        try {
            setShop(await buildflow.shop());
        } catch (error) {
            setProblem(message(error));
        }
    }, []);
    useEffect(() => {
        void reload();
        api.users().then(
            (people) => setMembers(people.filter((person) => person.status === "active")),
            () => setMembers([]),
        );
        const timer = setInterval(() => {
            if (!document.hidden) {
                void reload();
            }
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [reload]);

    // /buildflow/shop?add=12: a part for component 12, from its panel on the bill of design.
    useEffect(() => {
        const add = Number(new URLSearchParams(window.location.search).get("add"));
        if (!add || !me) {
            return;
        }
        navigate("/buildflow/shop", { replace: true });
        buildflow.component(add).then(
            (component) => {
                const link = (kind: string) => component.links.find((each) => each.kind === kind)?.url ?? "";
                setEditing({
                    ...blankDraft(me.id),
                    name: component.name,
                    programId: component.program_id,
                    componentId: component.id,
                    drawing: link("drawing"),
                    cad: link("cad"),
                });
            },
            (error: unknown) => setProblem(message(error)),
        );
    }, [me]);

    if (!me) {
        return null;
    }
    const tab = (to: string, name: ShopSection, label: string) => (
        <Link to={to} aria-current={section === name ? "page" : undefined}>
            {label}
        </Link>
    );
    return (
        <section className="bf-shop">
            <div className="page-head">
                <h1 className="page-title">Shop</h1>
                <div className="page-actions">
                    {shop && (
                        <button type="button" className="button-small" onClick={() => exportCsv(shop)}>
                            Export CSV
                        </button>
                    )}
                    {section === "queue" && shop && (
                        <button type="button" className="button-primary" onClick={() => setEditing(blankDraft(me.id))}>
                            Add part
                        </button>
                    )}
                </div>
            </div>
            <p className="muted bf-lead">
                The parts the team needs machined, how much work each machine has waiting, and who can run it. Anyone
                can add a part, or move one along; each person says how far they&apos;re trained on each machine.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            {shop === null && !problem && <p className="muted">Loading…</p>}
            {shop && <LoadStrip shop={shop} />}
            <nav className="bf-shop-tabs" aria-label="Shop">
                {tab("/buildflow/shop", "queue", "Queue")}
                {tab("/buildflow/shop/skills", "skills", "Who's trained")}
                {shop?.can_edit_machines && tab("/buildflow/shop/machines", "machines", "Machines")}
            </nav>
            {shop && section === "queue" && (
                <Queue shop={shop} onEdit={(part) => setEditing(draftOf(part))} onChanged={reload} />
            )}
            {shop && section === "skills" && <Skills shop={shop} members={members} onChanged={reload} />}
            {shop && section === "machines" && shop.can_edit_machines && <Machines shop={shop} onChanged={reload} />}
            {shop && editing && (
                <PartForm
                    shop={shop}
                    members={members}
                    draft={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void reload();
                    }}
                />
            )}
        </section>
    );
}

/** Each machine's open work: its hours waiting, a bar against the busiest, and who can run it. */
function LoadStrip({ shop }: { shop: Shop }) {
    const busiest = Math.max(1, ...shop.load.map((each) => each.hours));
    const names = new Map(shop.machines.map((m) => [m.id, m.name]));
    return (
        <div className="bf-shop-load" role="list" aria-label="Each machine's open work">
            {shop.load.map((each: Load) => (
                <div key={each.machine_id} className="bf-shop-machine" role="listitem">
                    <div className="bf-shop-machine-name">{names.get(each.machine_id)}</div>
                    <div className="bf-shop-machine-hours">
                        {hours(each.hours)}
                        <small> h open</small>
                    </div>
                    <div className="bf-shop-bar" aria-hidden="true">
                        <i style={{ width: `${((each.hours / busiest) * 100).toFixed(1)}%` }} />
                    </div>
                    <div className="bf-shop-machine-meta muted">
                        <span>
                            {each.parts} {each.parts === 1 ? "part" : "parts"}
                            {each.unestimated > 0 && `, ${each.unestimated} not estimated`}
                        </span>
                        <span>
                            {each.operators} can run it, {each.trainers} {each.trainers === 1 ? "trains" : "train"}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}

// --- the queue ------------------------------------------------------------------------------------------------------

type Shown = "open" | "all" | ShopStatus;

function Queue({ shop, onEdit, onChanged }: { shop: Shop; onEdit: (part: ShopPart) => void; onChanged: () => void }) {
    const [machine, setMachine] = useState(0);
    const [shown, setShown] = useState<Shown>("open");
    const [search, setSearch] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const [taken, setTaken] = useState<ShopPart | null>(null); // just taken off the queue: to put back
    const [removed, setRemoved] = useState<ShopPart[] | null>(null);

    const parts = useMemo(() => {
        const words = search.trim().toLowerCase();
        return shop.parts.filter(
            (part) =>
                (!machine || part.machine_id === machine) &&
                (shown === "all" || (shown === "open" ? part.status !== "done" : part.status === shown)) &&
                (!words ||
                    [
                        part.name,
                        part.material,
                        part.requester?.name,
                        part.machinist?.name,
                        part.program?.name,
                        part.component?.name,
                    ].some((text) => (text ?? "").toLowerCase().includes(words))),
        );
    }, [shop, machine, shown, search]);

    async function act(action: () => Promise<unknown>) {
        setProblem(null);
        try {
            await action();
            onChanged();
        } catch (error) {
            setProblem(message(error));
        }
    }
    const takeOff = (part: ShopPart) =>
        act(async () => {
            await buildflow.removeShopPart(part.id);
            setTaken(part);
        });
    const putBack = (part: ShopPart) =>
        act(async () => {
            await buildflow.restoreShopPart(part.id);
            setTaken(null);
            setRemoved((now) => now?.filter((each) => each.id !== part.id) ?? null);
        });

    return (
        <section className="bf-shop-queue" aria-label="Queue">
            <div className="bf-shop-filters">
                <select
                    aria-label="Machine"
                    value={machine}
                    onChange={(event) => setMachine(Number(event.target.value))}
                >
                    <option value={0}>All machines</option>
                    {shop.machines.map((each) => (
                        <option key={each.id} value={each.id}>
                            {each.name}
                        </option>
                    ))}
                </select>
                <select aria-label="Status" value={shown} onChange={(event) => setShown(event.target.value as Shown)}>
                    <option value="open">Not done</option>
                    <option value="all">All</option>
                    {SHOP_STATUSES.map((status) => (
                        <option key={status} value={status}>
                            {SHOP_STATUS_NAMES[status]}
                        </option>
                    ))}
                </select>
                <input
                    type="search"
                    aria-label="Search the queue"
                    placeholder="Search part, material, people, program"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            {taken && (
                <Notice>
                    Took {taken.name} off the queue.{" "}
                    <button type="button" className="button-small" onClick={() => void putBack(taken)}>
                        Put it back
                    </button>
                </Notice>
            )}
            {parts.length === 0 ? (
                <p className="empty">
                    {shop.parts.length === 0
                        ? "Nothing's queued. Add a part to put the first job in the queue."
                        : "No parts match these filters."}
                </p>
            ) : (
                <div className="table-scroll">
                    <table className="table bf-shop-table" aria-label="Parts in the queue">
                        <thead>
                            <tr>
                                <th>Part</th>
                                <th>Material</th>
                                <th>Machine</th>
                                <th className="numeric">Qty</th>
                                <th className="numeric">Est. hours</th>
                                <th>Status</th>
                                <th>Drawing, CAD</th>
                                <th>Can make it</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {parts.map((part) => (
                                <PartRow
                                    key={part.id}
                                    shop={shop}
                                    part={part}
                                    onStatus={(status) => void act(() => buildflow.changeShopPart(part.id, { status }))}
                                    onEdit={() => onEdit(part)}
                                    onRemove={() => void takeOff(part)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <section className="bf-shop-removed">
                {removed === null ? (
                    <button
                        type="button"
                        className="button-small"
                        onClick={() =>
                            buildflow.shop(true).then(
                                (found) => setRemoved(found.parts),
                                (error: unknown) => setProblem(message(error)),
                            )
                        }
                    >
                        Show parts taken off the queue
                    </button>
                ) : (
                    <>
                        <h2>Taken off the queue</h2>
                        {removed.length === 0 ? (
                            <p className="muted">None.</p>
                        ) : (
                            <ul className="plain">
                                {removed.map((part) => (
                                    <li key={part.id}>
                                        {part.name} <span className="muted">· {part.machine}</span>{" "}
                                        <button
                                            type="button"
                                            className="button-small"
                                            onClick={() => void putBack(part)}
                                        >
                                            Put back
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </section>
        </section>
    );
}

function PartRow({
    shop,
    part,
    onStatus,
    onEdit,
    onRemove,
}: {
    shop: Shop;
    part: ShopPart;
    onStatus: (status: ShopStatus) => void;
    onEdit: () => void;
    onRemove: () => void;
}) {
    const who = [
        part.requester && `RE ${part.requester.name}`,
        part.machinist && `making it: ${part.machinist.name}`,
    ].filter(Boolean);
    const late =
        part.need_by !== null && part.status !== "done" && part.need_by < new Date().toISOString().slice(0, 10);
    const able = canRun(shop, part.machine_id);
    return (
        <tr>
            <td>
                <div className="bf-shop-part-name">{part.name}</div>
                {part.program && (
                    <div className="bf-small">
                        For{" "}
                        <Link
                            to={
                                part.component
                                    ? `/buildflow/programs/${part.program.id}?phase=build&component=${part.component.id}`
                                    : `/buildflow/programs/${part.program.id}`
                            }
                        >
                            {part.component ? `${part.program.name} · ${part.component.name}` : part.program.name}
                        </Link>
                    </div>
                )}
                <div className="muted bf-small">
                    {who.join(" · ")}
                    {part.need_by && (
                        <span className={late ? "bf-late" : undefined}>
                            {who.length > 0 && " · "}need by {day(part.need_by)}
                        </span>
                    )}
                </div>
                {part.note && <div className="muted bf-small bf-shop-note">{part.note}</div>}
            </td>
            <td>{part.material || <span className="muted">—</span>}</td>
            <td>
                <span className="bf-shop-tag">{part.machine}</span>
            </td>
            <td className="numeric">{part.quantity}</td>
            <td className="numeric">{part.hours === null ? <span className="muted">—</span> : hours(part.hours)}</td>
            <td>
                <select
                    className={`bf-shop-status bf-shop-status-${part.status}`}
                    aria-label={`Status of ${part.name}`}
                    value={part.status}
                    onChange={(event) => onStatus(event.target.value as ShopStatus)}
                >
                    {SHOP_STATUSES.map((status) => (
                        <option key={status} value={status}>
                            {SHOP_STATUS_NAMES[status]}
                        </option>
                    ))}
                </select>
            </td>
            <td>
                <span className="bf-shop-links">
                    <PartLink url={part.drawing} label="Drawing" />
                    <PartLink url={part.cad} label="CAD" />
                    {!part.drawing && !part.cad && <span className="muted">—</span>}
                </span>
            </td>
            <td className="bf-small">
                {able.length > 0 ? (
                    able.map((person) => person.name).join(", ")
                ) : (
                    <span className="muted">No one yet</span>
                )}
            </td>
            <td>
                <span className="bf-shop-actions">
                    <button type="button" className="button-small" aria-label={`Edit ${part.name}`} onClick={onEdit}>
                        Edit
                    </button>
                    <button
                        type="button"
                        className="button-small"
                        aria-label={`Take ${part.name} off the queue`}
                        onClick={onRemove}
                    >
                        Remove
                    </button>
                </span>
            </td>
        </tr>
    );
}

/** A part's drawing or CAD: a page of the site's own opens here; anywhere else, in a tab of its own. */
function PartLink({ url, label }: { url: string; label: string }) {
    if (!url) {
        return null;
    }
    return url.startsWith("/") ? (
        <Link to={url}>{label}</Link>
    ) : (
        <a href={url} target="_blank" rel="noopener noreferrer">
            {label} ↗
        </a>
    );
}

// --- a part, to queue or change -------------------------------------------------------------------------------------

interface Draft {
    id: number | null; // null: a new part
    name: string;
    programId: number | null;
    componentId: number | null;
    machineId: number;
    material: string;
    quantity: string;
    hours: string;
    drawing: string;
    cad: string;
    status: ShopStatus;
    requesterId: number | null;
    machinistId: number | null;
    needBy: string;
    note: string;
}

const blankDraft = (me: number): Draft => ({
    id: null,
    name: "",
    programId: null,
    componentId: null,
    machineId: 0,
    material: "",
    quantity: "1",
    hours: "",
    drawing: "",
    cad: "",
    status: "queued",
    requesterId: me,
    machinistId: null,
    needBy: "",
    note: "",
});

const draftOf = (part: ShopPart): Draft => ({
    id: part.id,
    name: part.name,
    programId: part.program?.id ?? null,
    componentId: part.component?.id ?? null,
    machineId: part.machine_id,
    material: part.material,
    quantity: String(part.quantity),
    hours: part.hours === null ? "" : String(part.hours),
    drawing: part.drawing,
    cad: part.cad,
    status: part.status,
    requesterId: part.requester?.id ?? null,
    machinistId: part.machinist?.id ?? null,
    needBy: part.need_by ?? "",
    note: part.note,
});

function PartForm({
    shop,
    members,
    draft,
    onClose,
    onSaved,
}: {
    shop: Shop;
    members: UserRef[];
    draft: Draft;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [form, setForm] = useState<Draft>(draft);
    const [programs, setPrograms] = useState<Program[]>([]);
    const [bill, setBill] = useState<ProgramDetail | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const set = (change: Partial<Draft>) => setForm((now) => ({ ...now, ...change }));

    useEffect(() => {
        buildflow.programs().then(setPrograms, () => setPrograms([]));
    }, []);
    useEffect(() => {
        setBill(null);
        if (form.programId !== null) {
            buildflow.program(form.programId).then(setBill, () => setBill(null));
        }
    }, [form.programId]);

    // Machines that take new parts, and the one it's on even if that's retired.
    const machines = shop.machines.filter((each: Machine) => !each.retired || each.id === draft.machineId);
    const able = form.machineId ? canRun(shop, form.machineId) : [];
    const others = members.filter((person) => !able.some((each) => each.id === person.id));
    const quantity = Number(form.quantity);
    const estimate = form.hours.trim() === "" ? null : Number(form.hours);
    const ready =
        form.name.trim() !== "" &&
        form.machineId !== 0 &&
        Number.isInteger(quantity) &&
        quantity >= 1 &&
        (estimate === null || (Number.isFinite(estimate) && estimate >= 0));

    async function save() {
        setBusy(true);
        setProblem(null);
        const body: ShopPartChange & { name: string; machine_id: number } = {
            name: form.name.trim(),
            machine_id: form.machineId,
            component_id: form.componentId,
            program_id: form.componentId === null ? form.programId : null,
            material: form.material.trim(),
            quantity,
            hours: estimate,
            drawing: form.drawing.trim(),
            cad: form.cad.trim(),
            status: form.status,
            requester_id: form.requesterId,
            machinist_id: form.machinistId,
            need_by: form.needBy || null,
            note: form.note.trim(),
        };
        try {
            if (form.id === null) {
                await buildflow.addShopPart(body);
            } else {
                await buildflow.changeShopPart(form.id, body);
            }
            onSaved();
        } catch (error) {
            setProblem(message(error));
            setBusy(false);
        }
    }

    const person = (value: string) => (value === "" ? null : Number(value));
    return (
        <Dialog
            title={form.id === null ? "Add a part" : `Edit ${draft.name}`}
            confirm={form.id === null ? "Add it" : "Save"}
            busy={busy}
            disabled={!ready}
            onConfirm={() => void save()}
            onCancel={onClose}
            wide
            tall
        >
            <div className="bf-shop-form">
                <label className="field bf-shop-wide">
                    Part
                    <input
                        autoFocus
                        value={form.name}
                        maxLength={200}
                        placeholder="Injector faceplate"
                        onChange={(event) => set({ name: event.target.value })}
                    />
                </label>
                <label className="field">
                    <span>
                        For <span className="muted">(optional)</span>
                    </span>
                    <select
                        value={form.programId ?? ""}
                        onChange={(event) => set({ programId: person(event.target.value), componentId: null })}
                    >
                        <option value="">No program</option>
                        {programs.map((each) => (
                            <option key={each.id} value={each.id}>
                                {each.name}
                            </option>
                        ))}
                        {form.programId !== null && !programs.some((each) => each.id === form.programId) && (
                            <option value={form.programId}>{bill?.name ?? "This program"}</option>
                        )}
                    </select>
                </label>
                <label className="field">
                    Component
                    <select
                        value={form.componentId ?? ""}
                        disabled={form.programId === null}
                        onChange={(event) => set({ componentId: person(event.target.value) })}
                    >
                        <option value="">The program as a whole</option>
                        {bill?.subsystems.map((subsystem) => (
                            <optgroup key={subsystem.id} label={subsystem.name}>
                                {bill.components
                                    .filter((each) => each.subsystem_id === subsystem.id)
                                    .map((each) => (
                                        <option key={each.id} value={each.id}>
                                            {each.name}
                                        </option>
                                    ))}
                            </optgroup>
                        ))}
                    </select>
                </label>
                <label className="field">
                    Machine
                    <select value={form.machineId} onChange={(event) => set({ machineId: Number(event.target.value) })}>
                        <option value={0}>Pick one…</option>
                        {machines.map((each) => (
                            <option key={each.id} value={each.id}>
                                {each.name}
                                {each.retired ? " (retired)" : ""}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    Material
                    <input
                        list="bf-shop-materials"
                        value={form.material}
                        maxLength={100}
                        placeholder="6061-T6 aluminum"
                        onChange={(event) => set({ material: event.target.value })}
                    />
                    <datalist id="bf-shop-materials">
                        {MATERIALS.map((each) => (
                            <option key={each} value={each} />
                        ))}
                    </datalist>
                </label>
                <label className="field">
                    Quantity
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={form.quantity}
                        onChange={(event) => set({ quantity: event.target.value })}
                    />
                </label>
                <label className="field">
                    <span>
                        Est. hours <span className="muted">(all of them)</span>
                    </span>
                    <input
                        type="number"
                        min={0}
                        step={0.25}
                        value={form.hours}
                        placeholder="4"
                        onChange={(event) => set({ hours: event.target.value })}
                    />
                </label>
                <label className="field bf-shop-wide">
                    <span>
                        Drawing <span className="muted">(a link, or a page here like /vault/file/12)</span>
                    </span>
                    <input value={form.drawing} onChange={(event) => set({ drawing: event.target.value })} />
                </label>
                <label className="field bf-shop-wide">
                    CAD
                    <input value={form.cad} onChange={(event) => set({ cad: event.target.value })} />
                </label>
                <label className="field">
                    Status
                    <select value={form.status} onChange={(event) => set({ status: event.target.value as ShopStatus })}>
                        {SHOP_STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {SHOP_STATUS_NAMES[status]}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    Responsible engineer
                    <select
                        value={form.requesterId ?? ""}
                        onChange={(event) => set({ requesterId: person(event.target.value) })}
                    >
                        <option value="">No one</option>
                        {members.map((each) => (
                            <option key={each.id} value={each.id}>
                                {each.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>
                        Machinist <span className="muted">(optional)</span>
                    </span>
                    <select
                        value={form.machinistId ?? ""}
                        onChange={(event) => set({ machinistId: person(event.target.value) })}
                    >
                        <option value="">No one yet</option>
                        {able.length > 0 && (
                            <optgroup label="Can run the machine">
                                {able.map((each) => (
                                    <option key={each.id} value={each.id}>
                                        {each.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        <optgroup label={able.length > 0 ? "Everyone else" : "Everyone"}>
                            {others.map((each) => (
                                <option key={each.id} value={each.id}>
                                    {each.name}
                                </option>
                            ))}
                        </optgroup>
                    </select>
                </label>
                <label className="field">
                    <span>
                        Need by <span className="muted">(optional)</span>
                    </span>
                    <input type="date" value={form.needBy} onChange={(event) => set({ needBy: event.target.value })} />
                </label>
                <label className="field bf-shop-wide">
                    <span>
                        Note <span className="muted">(what it&apos;s waiting on, say)</span>
                    </span>
                    <textarea
                        rows={2}
                        maxLength={2000}
                        value={form.note}
                        onChange={(event) => set({ note: event.target.value })}
                    />
                </label>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

// --- who's trained on what ------------------------------------------------------------------------------------------

function Pips({ level }: { level: number }) {
    return (
        <span className={`bf-pips${level ? "" : " bf-pips-none"}`} aria-hidden="true">
            {[1, 2, 3].map((step) => (
                <i key={step} className={step <= level ? "on" : undefined} />
            ))}
        </span>
    );
}

function Skills({ shop, members, onChanged }: { shop: Shop; members: UserRef[]; onChanged: () => Promise<void> }) {
    const { me } = useSession();
    const admin = me?.is_admin ?? false;
    const [whose, setWhose] = useState(me?.id ?? 0);
    const [levels, setLevels] = useState<Record<number, number>>({});
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const machines = shop.machines.filter((each) => !each.retired);
    const kept = shop.trained.find((each) => each.user.id === whose)?.levels;

    // Their levels as the server has them, unless they're being changed.
    useEffect(() => {
        if (!dirty) {
            setLevels(Object.fromEntries(machines.map((each) => [each.id, kept?.[each.id] ?? 0])));
        }
    }, [whose, shop, dirty]);

    const name = whose === me?.id ? "you" : (members.find((each) => each.id === whose)?.name ?? "them");
    async function save() {
        setBusy(true);
        setProblem(null);
        try {
            await buildflow.setLevels(whose, levels);
            await onChanged(); // the levels kept, before the form goes back to showing them
            setDirty(false);
            setSaid(`Saved how far ${name === "you" ? "you're" : `${name} is`} trained.`);
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    }
    return (
        <section className="bf-shop-skills" aria-label="Who's trained">
            <form
                className="bf-shop-card"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <h2>{whose === me?.id ? "Your experience" : `${name}'s experience`}</h2>
                {admin && (
                    <label className="field bf-shop-whose">
                        <span>
                            Whose <span className="muted">(admins can change anyone&apos;s)</span>
                        </span>
                        <select
                            value={whose}
                            onChange={(event) => {
                                setWhose(Number(event.target.value));
                                setDirty(false);
                                setSaid(null);
                            }}
                        >
                            {members.map((each) => (
                                <option key={each.id} value={each.id}>
                                    {each.id === me?.id ? `${each.name} (you)` : each.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <p className="muted bf-small bf-shop-legend">
                    {LEVEL_NAMES.map((label, level) => (
                        <span key={level}>
                            <Pips level={level} /> {level} {label}
                        </span>
                    ))}
                </p>
                <div className="bf-shop-levels">
                    {machines.map((each) => (
                        <div key={each.id} className="bf-shop-level" role="group" aria-label={`${each.name} level`}>
                            <span className="bf-shop-machine-name">{each.name}</span>
                            <span className="bf-shop-segments">
                                {[0, 1, 2, 3].map((level) => (
                                    <button
                                        key={level}
                                        type="button"
                                        title={LEVEL_NAMES[level]}
                                        aria-label={`${each.name}: ${LEVEL_NAMES[level]}`}
                                        aria-pressed={(levels[each.id] ?? 0) === level}
                                        onClick={() => {
                                            setLevels((now) => ({ ...now, [each.id]: level }));
                                            setDirty(true);
                                            setSaid(null);
                                        }}
                                    >
                                        {level}
                                    </button>
                                ))}
                            </span>
                        </div>
                    ))}
                </div>
                {problem && <Notice tone="error">{problem}</Notice>}
                <div className="bf-shop-form-foot">
                    {said && <span className="muted">{said}</span>}
                    <button type="submit" className="button-primary" disabled={busy || !dirty}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
            {shop.trained.length === 0 ? (
                <p className="empty">No one&apos;s said how far they&apos;re trained yet. Be the first, above.</p>
            ) : (
                <div className="table-scroll">
                    <table className="table" aria-label="Who's trained on what">
                        <thead>
                            <tr>
                                <th>Who</th>
                                {machines.map((each) => (
                                    <th key={each.id}>{each.name}</th>
                                ))}
                                {admin && <th />}
                            </tr>
                        </thead>
                        <tbody>
                            {shop.trained.map((each) => (
                                <tr key={each.user.id}>
                                    <td>
                                        {each.user.name}
                                        {each.user.id === me?.id && <span className="bf-shop-you"> you</span>}
                                    </td>
                                    {machines.map((machine) => {
                                        const level = each.levels[machine.id] ?? 0;
                                        return (
                                            <td key={machine.id} aria-label={`${machine.name}: ${LEVEL_NAMES[level]}`}>
                                                <Pips level={level} />{" "}
                                                <span className="muted bf-small">{LEVEL_NAMES[level]}</span>
                                            </td>
                                        );
                                    })}
                                    {admin && (
                                        <td>
                                            <button
                                                type="button"
                                                className="button-small"
                                                aria-label={`Change ${each.user.name}'s experience`}
                                                onClick={() => {
                                                    setWhose(each.user.id);
                                                    setDirty(false);
                                                    setSaid(null);
                                                }}
                                            >
                                                Change
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

// --- the machines (admins) ------------------------------------------------------------------------------------------

function Machines({ shop, onChanged }: { shop: Shop; onChanged: () => void }) {
    const [names, setNames] = useState<Record<number, string>>({});
    const [adding, setAdding] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    async function act(action: () => Promise<unknown>) {
        setProblem(null);
        try {
            await action();
            onChanged();
        } catch (error) {
            setProblem(message(error));
        }
    }
    return (
        <section className="bf-shop-machines" aria-label="Machines">
            <p className="muted">
                The machines parts are made on, and people are trained on. A machine that&apos;s retired takes no new
                parts, and keeps those made on it.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            <ul className="plain bf-shop-machine-list">
                {shop.machines.map((each) => {
                    const name = names[each.id] ?? each.name;
                    return (
                        <li key={each.id}>
                            <input
                                aria-label={`Name of the ${each.name}`}
                                value={name}
                                maxLength={40}
                                onChange={(event) => setNames((now) => ({ ...now, [each.id]: event.target.value }))}
                            />
                            {name.trim() && name.trim() !== each.name && (
                                <button
                                    type="button"
                                    className="button-small"
                                    onClick={() =>
                                        void act(async () => {
                                            await buildflow.changeMachine(each.id, { name: name.trim() });
                                            setNames((now) => {
                                                const next = { ...now };
                                                delete next[each.id];
                                                return next;
                                            });
                                        })
                                    }
                                >
                                    Rename
                                </button>
                            )}
                            {each.retired && <span className="muted"> retired</span>}
                            <button
                                type="button"
                                className="button-small"
                                onClick={() =>
                                    void act(() => buildflow.changeMachine(each.id, { retired: !each.retired }))
                                }
                            >
                                {each.retired ? "Bring back" : "Retire"}
                            </button>
                        </li>
                    );
                })}
            </ul>
            <form
                className="bf-shop-add-machine"
                onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                        await buildflow.addMachine(adding.trim());
                        setAdding("");
                    });
                }}
            >
                <input
                    aria-label="New machine"
                    placeholder="Laser cutter"
                    maxLength={40}
                    value={adding}
                    onChange={(event) => setAdding(event.target.value)}
                />
                <button type="submit" className="button-small" disabled={!adding.trim()}>
                    Add machine
                </button>
            </form>
        </section>
    );
}

// --- a spreadsheet of it all ----------------------------------------------------------------------------------------

/** The queue and who's trained, as a CSV file to open in a spreadsheet, as the tracker's export was. */
function exportCsv(shop: Shop) {
    const cell = (value: unknown) => {
        const text = value === null || value === undefined ? "" : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const row = (values: unknown[]) => values.map(cell).join(",");
    const machines = shop.machines.filter((each) => !each.retired);
    const lines = [
        row([
            "part",
            "program",
            "component",
            "machine",
            "material",
            "quantity",
            "est. hours",
            "status",
            "responsible engineer",
            "machinist",
            "need by",
            "drawing",
            "cad",
            "note",
        ]),
        ...shop.parts.map((part) =>
            row([
                part.name,
                part.program?.name,
                part.component?.name,
                part.machine,
                part.material,
                part.quantity,
                part.hours,
                SHOP_STATUS_NAMES[part.status],
                part.requester?.name,
                part.machinist?.name,
                part.need_by,
                part.drawing,
                part.cad,
                part.note,
            ]),
        ),
        "",
        row(["engineer", ...machines.map((each) => each.name)]),
        ...shop.trained.map((each) => row([each.user.name, ...machines.map((m) => each.levels[m.id] ?? 0)])),
    ];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    // Named for the site, as its settings name it: yjsp-shop-2026-11-16.csv.
    const site =
        siteName()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "site";
    link.download = `${site}-shop-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
