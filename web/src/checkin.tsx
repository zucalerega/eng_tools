import { useState } from "react";
import { api, type VaultFile } from "./api";
import { keptReferences, WEB_HOST } from "./checkouts";
import { Dialog, Notice } from "./components";
import { formatSize } from "./format";
import { extension, useChange } from "./manage";
import { kindOf } from "./paths";
import { useVault } from "./store";
import { sha256 } from "./upload";

// Checking out, checking in, and undoing check-outs from the web app (see checkouts.ts).

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Check files out here, in the web app, saying how to check them in. */
export function CheckOutDialog({ files, onClose }: { files: VaultFile[]; onClose: () => void }) {
    const { busy, problem, run } = useChange(onClose);
    const one = files.length === 1;
    return (
        <Dialog
            title={one ? `Check out ${files[0]!.name}?` : `Check out ${files.length} files?`}
            confirm="Check out"
            busy={busy}
            onConfirm={() =>
                run(() =>
                    api.checkout(
                        files.map((file) => file.id),
                        WEB_HOST,
                    ),
                )
            }
            onCancel={onClose}
        >
            <p>
                {one ? "It's" : "They're"} checked out to you here, in the web app, so nobody else can change{" "}
                {one ? "it" : "them"}. Download {one ? "it" : "them"}, make your changes, then check{" "}
                {one ? "it" : "them"} in: on {one ? "its page" : "each one's page"}, or by uploading{" "}
                {one ? "it into its folder" : "them into their folders"}.
            </p>
            <p className="muted">
                To change {one ? "it" : "them"} in SolidWorks instead, open {one ? "it" : "them"} there: the Vault tab
                offers to move the check-out to that computer.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * Check in a file checked out here: its new version, uploaded, with a comment. A drawing stays linked to what
 * it shows; an assembly's new version records no parts, which the web app can't read.
 */
export function CheckinDialog({ file, onClose }: { file: VaultFile; onClose: () => void }) {
    const vault = useVault();
    const { busy, problem, run } = useChange(onClose);
    const [picked, setPicked] = useState<{ name: string; data: Uint8Array<ArrayBuffer>; sha256: string } | null>(null);
    const [reading, setReading] = useState(false);
    const [comment, setComment] = useState("");
    const kind = kindOf(file.name);
    const shows = kind === "drawing" ? keptReferences(vault, file) : [];
    const unlinked = kind === "drawing" && shows.length === 0;
    const wrongType = picked !== null && extension(picked.name) !== extension(file.name);
    const same = picked !== null && picked.sha256 === file.sha256;

    async function pick(chosen: File | undefined) {
        setPicked(null);
        if (!chosen) {
            return;
        }
        setReading(true);
        try {
            const data = new Uint8Array(await chosen.arrayBuffer());
            setPicked({ name: chosen.name, data, sha256: await sha256(data) });
        } finally {
            setReading(false);
        }
    }

    const checkIn = async () => {
        if (!picked) {
            return;
        }
        if (!(await api.hasBlob(picked.sha256))) {
            await api.uploadBlob(picked.sha256, picked.data);
        }
        const references = shows.map((path) => ({ path }));
        const item = { path: file.path, sha256: picked.sha256, size: picked.data.length, references };
        await api.checkin({ comment: comment.trim(), host: WEB_HOST, items: [item] });
    };

    return (
        <Dialog
            title={`Check in ${file.name}`}
            confirm={same ? "End the check-out" : "Check in"}
            busy={busy}
            disabled={!picked || reading || wrongType || unlinked}
            onConfirm={() => run(checkIn)}
            onCancel={onClose}
        >
            {unlinked ? (
                <Notice tone="warning">
                    This drawing isn't linked to the part or assembly it shows, so check it in from SolidWorks, where
                    Vault records what each drawing shows.
                </Notice>
            ) : (
                <label className="field">
                    The new version
                    <input
                        type="file"
                        accept={extension(file.name)}
                        disabled={busy}
                        onChange={(event) => void pick(event.target.files?.[0])}
                    />
                </label>
            )}
            {wrongType && (
                <p className="field-problem" role="alert">
                    That isn't a {extension(file.name)} file: pick the new {file.name}.
                </p>
            )}
            {picked && !wrongType && (
                <p className="muted">
                    {same
                        ? `It's the same as v${file.version}, so checking in only ends your check-out.`
                        : `It becomes v${file.version + 1} of ${file.name} (${formatSize(picked.data.length)}).`}
                </p>
            )}
            {kind === "assembly" && (
                <Notice tone="warning">
                    The web app can't read which parts an assembly uses, so v{file.version + 1} won't list them until
                    it's checked in from SolidWorks (check it out there, then in).
                </Notice>
            )}
            {shows.length > 0 && (
                <p className="muted">
                    It stays linked to {shows.map(nameOf).join(", ")}, as v{file.version} is.
                </p>
            )}
            <label className="field">
                What changed? (shown in the history)
                <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={5000} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

/**
 * Undo your check-outs: the files go back to being free, as they were. Changes made on a computer stay on it,
 * which it says first.
 */
export function UndoCheckoutDialog({ files, onClose }: { files: VaultFile[]; onClose: () => void }) {
    const { busy, problem, run } = useChange(onClose);
    const one = files.length === 1;
    const computers = [...new Set(files.map((file) => file.checked_out?.host ?? WEB_HOST))].filter(
        (host) => host !== WEB_HOST,
    );
    return (
        <Dialog
            title={one ? `Undo your check-out of ${files[0]!.name}?` : `Undo your check-outs of ${files.length} files?`}
            confirm="Undo check-out"
            danger={computers.length > 0}
            busy={busy}
            onConfirm={() => run(() => api.releaseCheckouts(files.map((file) => file.id)))}
            onCancel={onClose}
        >
            <p>
                {one ? "It goes" : "They go"} back to how {one ? "it is" : "they are"} in the vault, free for anyone to
                check out. Nothing is checked in.
            </p>
            {computers.length > 0 && (
                <Notice tone="warning">
                    Changes you made on {computers.join(" and ")} stay there. To check them in after all, check{" "}
                    {one ? "it" : "them"} out there again.
                </Notice>
            )}
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}
