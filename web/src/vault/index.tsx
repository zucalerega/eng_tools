import { lazy, Suspense, useState } from "react";
import { Notice, Time } from "../components";
import { vaultApi } from "./api";
import { Link } from "../router";
import { WithFolderTree } from "./folderTree";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Admin";
import { Assemblies } from "./pages/Assemblies";
import { Browse } from "./pages/Browse";
import { FilePage } from "./pages/FilePage";
import { Locks } from "./pages/Locks";
import { SolidWorks } from "./pages/SolidWorks";
import { Trash } from "./pages/Trash";
import { folderFromUrl, sheetFormat, VAULT, vaultRoute } from "./paths";
import { useStore, useVault, type VaultState } from "./store";

// Vault: the team's CAD files. Its pages are under /vault (/vault/files/..., /vault/file/5, /vault/locks...), as
// Yorg's are under /yorg; the app switcher in the top bar goes between them. Its routes below are the paths without
// /vault (vaultRoute). Links from before it moved there still work (paths.movedToVault).

export { VaultMark } from "./components";
export { inVault, movedToVault, VAULT } from "./paths";

// Caliper, the 3D viewer, and three.js with it, load only when a file is opened in it; drawings and DXF files, which are
// flat, have a page of their own, without three.js.
const CaliperPage = lazy(() => import("./caliper/CaliperPage").then((module) => ({ default: module.CaliperPage })));
const DrawingPage = lazy(() => import("./caliper/DrawingPage").then((module) => ({ default: module.DrawingPage })));

/** Which of Vault's sections a page is in, for the top bar. */
export function vaultSection(pathname: string): string {
    const route = vaultRoute(pathname);
    return route === "/" || route.startsWith("/file") || route.startsWith("/trash") || route.startsWith("/caliper")
        ? "files"
        : (route.split("/")[1] ?? "");
}

/** Whether a page takes the whole window under the top bar: Caliper's 3D view. */
export function wholeWindow(pathname: string): boolean {
    return vaultRoute(pathname).startsWith("/caliper/");
}

/** Whether a page has the folder tree beside it, and so takes the window's width. */
export function withFolderTree(pathname: string): boolean {
    const route = vaultRoute(pathname);
    return route === "/" || route.startsWith("/files") || route.startsWith("/trash");
}

export function VaultPage({ pathname }: { pathname: string }) {
    const vault = useVault();
    if (vault.status === "loading") {
        return <p className="muted">Loading the vault…</p>;
    }
    if (vault.status === "failed") {
        return <Notice tone="error">Can't load the vault: {vault.error}. Trying again every few seconds.</Notice>;
    }
    return (
        <>
            {vault.error && (
                <Notice tone="warning">
                    Can't reach the server ({vault.error}). Showing what was here; trying again.
                </Notice>
            )}
            <PauseNotice />
            {page(vaultRoute(pathname), vault)}
        </>
    );
}

function page(route: string, vault: VaultState) {
    const file = /^\/file\/(\d+)\/?$/.exec(route);
    if (file) {
        return <FilePage key={file[1]} id={Number(file[1])} />;
    }
    const caliper = /^\/caliper\/(\d+)\/?$/.exec(route);
    if (caliper) {
        const id = Number(caliper[1]);
        const Viewer = sheetFormat(vault.files.get(id)?.name ?? "") !== null ? DrawingPage : CaliperPage;
        return (
            <Suspense fallback={<p className="muted caliper-page-message">Loading Caliper…</p>}>
                <Viewer key={caliper[1]} id={id} />
            </Suspense>
        );
    }
    // A folder's pages share the folder tree, which stays as it was from one to the next. A new folder's
    // page starts afresh: nothing selected, no search.
    if (route === "/" || route.startsWith("/files")) {
        const folder = folderFromUrl(route);
        return (
            <WithFolderTree folder={folder}>
                <Browse key={folder} folder={folder} />
            </WithFolderTree>
        );
    }
    if (route === "/trash" || route.startsWith("/trash/")) {
        const folder = folderFromUrl(route);
        return (
            <WithFolderTree folder={folder}>
                <Trash key={folder} folder={folder} />
            </WithFolderTree>
        );
    }
    switch (route.replace(/\/$/, "")) {
        case "/assemblies":
            return <Assemblies />;
        case "/locks":
            return <Locks />;
        case "/activity":
            return <Activity />;
        case "/solidworks":
            return <SolidWorks />;
        case "/admin":
            return <Admin section="people" />;
        case "/admin/whitelist":
            return <Admin section="whitelist" />;
        case "/admin/access":
            return <Admin section="access" />;
        case "/admin/numbers":
            return <Admin section="numbers" />;
        case "/admin/requests":
            return <Admin section="requests" />;
        default:
            return (
                <Notice tone="error">
                    There's no page here. <Link to={VAULT}>Go to the vault</Link>
                </Notice>
            );
    }
}

/** While an admin has the vault paused (docs/vault.md, "Pausing the vault"): changes wait until it's back. */
function PauseNotice() {
    const vault = useVault();
    const store = useStore();
    const [problem, setProblem] = useState<string | null>(null);
    const pause = vault.paused;
    if (!pause) {
        return null;
    }
    async function unpause() {
        try {
            await vaultApi.unpause();
            await store.refresh();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
    }
    const mine = pause.by.id === vault.me?.id;
    return (
        <Notice tone="warning">
            <span className="notice-row">
                <span>
                    {mine ? "You paused" : `${pause.by.name} paused`} the vault <Time at={pause.since} />
                    {pause.reason && `, for ${pause.reason}`}. Check-outs, check-ins, and other changes wait until it's
                    back{mine ? `, but yours from ${pause.host}` : ""}; you can still look at everything, download, and
                    undo your check-outs.
                    {problem && ` ${problem}`}
                </span>
                {vault.me?.is_admin && (
                    <button type="button" onClick={() => void unpause()}>
                        Unpause
                    </button>
                )}
            </span>
        </Notice>
    );
}
