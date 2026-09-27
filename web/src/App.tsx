import { canUseAdminMode, setAdminMode, useAdminMode } from "./admin";
import { Notice, usePopover, VaultMark } from "./components";
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
import { Link, usePathname } from "./router";
import { useVault, type VaultState } from "./store";
import { setTheme, useTheme, type Theme } from "./theme";

const THEMES: [Theme, string][] = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
];

export function App() {
    const vault = useVault();
    const pathname = usePathname();
    const adminMode = useAdminMode(vault);
    const section =
        pathname === "/" || pathname.startsWith("/file") || pathname.startsWith("/trash")
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
            <header className={`topbar ${adminMode ? "topbar-admin" : ""}`}>
                <Link to="/" className="brand">
                    <VaultMark />
                    <span className="wordmark">Vault</span>
                </Link>
                <nav className="nav" aria-label="Main">
                    {nav("/", "files", "Files")}
                    {nav("/assemblies", "assemblies", "Assemblies")}
                    {nav("/locks", "locks", "Checked out")}
                    {nav("/activity", "activity", "Activity")}
                    {nav("/solidworks", "solidworks", "SolidWorks")}
                    {canUseAdminMode(vault) && nav("/admin", "admin", "Admin")}
                </nav>
                <div className="topbar-end">
                    <AccountMenu vault={vault} />
                </div>
            </header>
            {adminMode && (
                <div className="admin-banner" role="status">
                    Admin mode is on: you can release other people's check-outs and revert files they have checked out.
                    <button type="button" className="button-small" onClick={() => setAdminMode(false)}>
                        Turn off
                    </button>
                </div>
            )}
            <main className={withTree ? "main-wide" : undefined}>
                {vault.error && vault.status === "ready" && (
                    <Notice tone="warning">
                        Can't reach the Vault server ({vault.error}). Showing what was here; trying again.
                    </Notice>
                )}
                <Page pathname={pathname} vault={vault} />
            </main>
        </>
    );
}

/** You, in the top bar: a menu with the theme, admin mode (for admins and leads), and signing out. */
function AccountMenu({ vault }: { vault: VaultState }) {
    const [open, setOpen, within] = usePopover<HTMLDivElement>();
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
                        <label className="check" title="Show overrides: release check-outs and force reverts">
                            <input
                                type="checkbox"
                                checked={adminMode}
                                onChange={(event) => setAdminMode(event.target.checked)}
                            />
                            Admin mode
                        </label>
                    )}
                    <hr />
                    <form method="post" action="/auth/logout">
                        <button type="submit" className="menu-item">
                            Sign out
                        </button>
                    </form>
                </div>
            )}
        </div>
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
