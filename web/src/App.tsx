import { useEffect, useState } from "react";
import { api } from "./api";
import { canUseAdminMode, setAdminMode, useAdminMode } from "./admin";
import { Dialog, Notice, usePopover, VaultMark } from "./components";
import { WithFolderTree } from "./folderTree";
import { folderFromUrl } from "./paths";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Admin";
import { Assemblies } from "./pages/Assemblies";
import { Browse } from "./pages/Browse";
import { FilePage } from "./pages/FilePage";
import { Locks } from "./pages/Locks";
import { SolidWorks } from "./pages/SolidWorks";
import { Trash } from "./pages/Trash";
import { inPreview, PREVIEW, sitePath } from "./preview";
import { Link, usePathname } from "./router";
import { useStore, useVault, type VaultState } from "./store";
import { setTheme, useTheme, type Theme } from "./theme";
import { inYorg, isWorkspace, YORG, YORG_ICON, YorgMark, YorgPage, yorgSection } from "./yorg";

let vaultIcon: string | null = null; // the tab's icon from index.html, put back on leaving Yorg

const THEMES: [Theme, string][] = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
];

export function App() {
    const vault = useVault();
    const pathname = usePathname();
    const adminMode = useAdminMode(vault);
    // Two apps share the site and its sign-in: the vault, and Yorg (test data, under /yorg). Yorg's preview (/yorg/dev,
    // admins) is Yorg as it will be, with what's new in its top bar too.
    const yorg = inYorg(pathname);
    const preview = inPreview(pathname) && vault.me?.is_admin === true;
    useEffect(() => {
        document.title = yorg ? YORG : "Vault";
        const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (icon) {
            vaultIcon ??= icon.getAttribute("href");
            icon.setAttribute("href", yorg ? YORG_ICON : (vaultIcon ?? ""));
        }
    }, [yorg]);
    const section = yorg
        ? yorgSection(pathname)
        : pathname === "/" || pathname.startsWith("/file") || pathname.startsWith("/trash")
          ? "files"
          : pathname.split("/")[1];
    const withTree = pathname === "/" || pathname.startsWith("/files") || pathname.startsWith("/trash");
    const nav = (to: string, name: string, label: string) => (
        <Link to={to} aria-current={section === name ? "page" : undefined}>
            {label}
        </Link>
    );
    return (
        <>
            <header className={`topbar ${adminMode && !yorg ? "topbar-admin" : ""}`}>
                <Link to={yorg ? "/yorg" : "/"} className="brand" aria-label={yorg ? YORG : "Vault"}>
                    {yorg ? <YorgMark /> : <VaultMark />}
                </Link>
                <nav className="apps" aria-label="Apps">
                    <Link to="/" className="wordmark" aria-current={yorg ? undefined : "page"}>
                        Vault
                    </Link>
                    <Link to="/yorg" className="wordmark" aria-current={yorg ? "page" : undefined}>
                        {YORG}
                    </Link>
                </nav>
                <nav className="nav" aria-label="Main">
                    {yorg ? (
                        <>
                            {nav("/yorg", "data", "Datasets")}
                            {nav("/yorg/views", "views", "Views")}
                            {preview && nav("/yorg/models", "models", "Models")}
                            {nav("/yorg/scripts", "scripts", "Scripts")}
                            {nav("/yorg/help", "help", "Help")}
                            {vault.me?.is_admin && !preview && (
                                <Link
                                    to={PREVIEW}
                                    className="preview-link"
                                    title="Yorg as it will be with what's new: only admins see it"
                                >
                                    Preview
                                </Link>
                            )}
                        </>
                    ) : (
                        <>
                            {nav("/", "files", "Files")}
                            {nav("/assemblies", "assemblies", "Assemblies")}
                            {nav("/locks", "locks", "Checked out")}
                            {nav("/activity", "activity", "Activity")}
                            {nav("/solidworks", "solidworks", "SolidWorks")}
                        </>
                    )}
                </nav>
                <div className="topbar-end">
                    <AccountMenu vault={vault} />
                </div>
            </header>
            {preview && (
                <div className="preview-banner" role="status">
                    Preview: Yorg as it will be, with system models. Only admins see it.
                    <Link to={sitePath(pathname)} exact className="button button-small">
                        Leave the preview
                    </Link>
                </div>
            )}
            {adminMode && !yorg && (
                <div className="admin-banner" role="status">
                    Admin mode is on: you can release other people's check-outs and revert files they have checked out.
                    <button type="button" className="button-small" onClick={() => setAdminMode(false)}>
                        Turn off
                    </button>
                </div>
            )}
            {yorg ? (
                <main className={isWorkspace(pathname) ? "main-full" : undefined}>
                    <YorgPage pathname={pathname} />
                </main>
            ) : (
                <main className={withTree ? "main-wide" : undefined}>
                    {vault.error && vault.status === "ready" && (
                        <Notice tone="warning">
                            Can't reach the Vault server ({vault.error}). Showing what was here; trying again.
                        </Notice>
                    )}
                    <Page pathname={pathname} vault={vault} />
                </main>
            )}
        </>
    );
}

/**
 * You, in the top bar: a menu with the theme, the Admin pages and admin mode (for admins, and folder leads,
 * who manage who can do what in their folders there), and signing out.
 */
function AccountMenu({ vault }: { vault: VaultState }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
    const [naming, setNaming] = useState(false);
    const theme = useTheme();
    const adminMode = useAdminMode(vault);
    const me = vault.me;
    const initials = (me?.name ?? "")
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map((word) => word[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    return (
        <div className="popover" ref={within}>
            <button
                type="button"
                className="account-button"
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={`Account: ${me?.name ?? ""}`}
                onClick={() => setOpen(!open)}
            >
                <span className="avatar" aria-hidden="true">
                    {initials || "?"}
                </span>
                <span className="me">{me?.name}</span>
            </button>
            {open && (
                <div className="menu">
                    <p className="menu-who">
                        {me?.name}
                        <span className="muted">{me?.email}</span>
                    </p>
                    <button
                        type="button"
                        className="menu-item"
                        onClick={() => {
                            setOpen(false);
                            setNaming(true);
                        }}
                    >
                        Change your name…
                    </button>
                    <hr />
                    <p className="menu-label" id="theme-label">
                        Theme
                    </p>
                    <div className="segmented" role="group" aria-labelledby="theme-label">
                        {THEMES.map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={theme === value}
                                onClick={() => setTheme(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {canUseAdminMode(vault) && (
                        <>
                            <hr />
                            <Link to="/admin" className="menu-item" onClick={() => setOpen(false)}>
                                Admin
                            </Link>
                            <label className="check" title="Show overrides: release check-outs and force reverts">
                                <input
                                    type="checkbox"
                                    checked={adminMode}
                                    onChange={(event) => setAdminMode(event.target.checked)}
                                />
                                Admin mode
                            </label>
                        </>
                    )}
                    <hr />
                    <form method="post" action="/auth/logout">
                        <button type="submit" className="menu-item">
                            Sign out
                        </button>
                    </form>
                </div>
            )}
            {naming && me && <NameDialog name={me.name} onClose={() => setNaming(false)} />}
        </div>
    );
}

/** Your name, as everyone sees it: on your check-outs, in the activity, in Admin. */
function NameDialog({ name: now, onClose }: { name: string; onClose: () => void }) {
    const store = useStore();
    const [name, setName] = useState(now);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            store.updateMe(await api.renameMe(name.trim()));
            void store.refresh(); // your name on files and check-outs, too
            onClose();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
            setBusy(false);
        }
    }
    return (
        <Dialog
            title="Change your name"
            confirm="Save"
            busy={busy}
            disabled={!name.trim() || name.trim() === now}
            onConfirm={() => void save()}
            onCancel={onClose}
        >
            <p className="muted">How everyone sees you: on your check-outs, in the activity, and in Admin.</p>
            <label className="field">
                Name
                <input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
            </label>
            {problem && <Notice tone="error">{problem}</Notice>}
        </Dialog>
    );
}

function Page({ pathname, vault }: { pathname: string; vault: VaultState }) {
    if (vault.status === "loading") {
        return <p className="muted">Loading the vault…</p>;
    }
    if (vault.status === "failed") {
        return <Notice tone="error">Can't load the vault: {vault.error}. Trying again every few seconds.</Notice>;
    }
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
