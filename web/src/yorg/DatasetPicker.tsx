import { useMemo, useState, type ReactNode } from "react";
import { ItemPicker, type BrowseFolder, type BrowseItem } from "../FolderBrowser";
import { formatDate } from "../format";
import { yorg, type DataFolder, type Dataset } from "./api";

// One of Yorg's datasets, picked from their folders as the datasets page shows them (the site's FolderBrowser): to
// compare with, to use a view with, to attach to a script. Listed each time it opens, so a test added meanwhile is
// there.

const keyOf = (id: number | null): string | null => (id === null ? null : String(id));

export function DatasetPicker({
    label,
    button,
    buttonClass,
    start,
    except,
    chosen = null,
    onPick,
}: {
    label: string; // the dropdown's name: "Compare with"
    button: ReactNode; // what its button says
    buttonClass?: string;
    start: number | null; // the folder it opens in (the folder of the dataset it's picked to go with); null: the top
    except?: readonly number[]; // datasets not to offer (those already there)
    chosen?: number | null;
    onPick: (dataset: Dataset) => void;
}) {
    const [lists, setLists] = useState<{ datasets: Dataset[]; folders: DataFolder[] } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const load = () => {
        setProblem(null);
        Promise.all([yorg.datasets(), yorg.folders()]).then(
            ([datasets, folders]) => setLists({ datasets, folders }),
            (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
        );
    };
    const left = (except ?? []).join(",");
    const folders = useMemo<BrowseFolder[] | null>(
        () =>
            lists?.folders.map((one) => ({ key: String(one.id), parent: keyOf(one.parent_id), name: one.name })) ??
            null,
        [lists],
    );
    const items = useMemo<BrowseItem[] | null>(() => {
        const leave = new Set(left.split(",").filter(Boolean).map(Number));
        return (
            lists?.datasets
                .filter((one) => one.status === "ready" && !leave.has(one.id))
                .map((one) => ({
                    key: String(one.id),
                    name: one.name,
                    folder: keyOf(one.folder_id),
                    note: formatDate(one.created_at),
                })) ?? null
        );
    }, [lists, left]);
    return (
        <ItemPicker
            label={label}
            button={button}
            buttonClass={buttonClass}
            folders={folders}
            items={items}
            start={keyOf(start)}
            chosen={keyOf(chosen)}
            top="Datasets"
            findLabel="Find a dataset"
            empty="No datasets in it"
            problem={problem}
            onOpen={load}
            onPick={(key) => {
                const found = lists?.datasets.find((one) => String(one.id) === key);
                if (found) {
                    onPick(found);
                }
            }}
        />
    );
}
