import { Notice } from "../components";
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
import { folderFromUrl } from "./paths";
import { useVault } from "./store";

// Vault: the team's CAD files. Its pages are the site's own paths (/, /files/..., /file/5, /locks...), as they were
// before the site had Yorg too; the app switcher in the top bar goes between it and Yorg (/yorg).

export { VaultMark } from "./components";

/** Which of Vault's sections a path is in, for the top bar. */
export function vaultSection(pathname: string): string {
    return pathname === "/" || pathname.startsWith("/file") || pathname.startsWith("/trash")
        ? "files"
        : (pathname.split("/")[1] ?? "");
}

/** Whether a page has the folder tree beside it, and so takes the window's width. */
export const withFolderTree = (pathname: string): boolean =>
    pathname === "/" || pathname.startsWith("/files") || pathname.startsWith("/trash");

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
            {page(pathname)}
        </>
    );
}

function page(pathname: string) {
    const file = /^\/file\/(\d+)\/?$/.exec(pathname);
    if (file) {
        return <FilePage key={file[1]} id={Number(file[1])} />;
    }
    // A folder's pages share the folder tree, which stays as it was from one to the next. A new folder's
    // page starts afresh: nothing selected, no search.
    if (pathname === "/" || pathname.startsWith("/files")) {
        const folder = folderFromUrl(pathname);
        return (
            <WithFolderTree folder={folder}>
                <Browse key={folder} folder={folder} />
            </WithFolderTree>
        );
    }
    if (pathname === "/trash" || pathname.startsWith("/trash/")) {
        const folder = folderFromUrl(pathname);
        return (
            <WithFolderTree folder={folder}>
                <Trash key={folder} folder={folder} />
            </WithFolderTree>
        );
    }
    switch (pathname.replace(/\/$/, "")) {
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
        case "/admin/access":
            return <Admin section="access" />;
        default:
            return (
                <Notice tone="error">
                    There's no page here. <Link to="/">Go to the vault</Link>
                </Notice>
            );
    }
}
