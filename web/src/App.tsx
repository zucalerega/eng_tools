import { canUseAdminMode, setAdminMode, useAdminMode } from "./admin";
import { Notice } from "./components";
import { folderFromUrl } from "./paths";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Admin";
import { Browse } from "./pages/Browse";
import { FilePage } from "./pages/FilePage";
import { Locks } from "./pages/Locks";
import { Link, usePathname } from "./router";
import { useVault, type VaultState } from "./store";

export function App() {
    const vault = useVault();
    const pathname = usePathname();
    const adminMode = useAdminMode(vault);
    const section = pathname === "/" || pathname.startsWith("/file") ? "files" : pathname.split("/")[1];
    const nav = (to: string, name: string, label: string) => (
        <Link to={to} aria-current={section === name ? "page" : undefined}>
            {label}
        </Link>
    );
    return (
        <>
            <header className={`topbar ${adminMode ? "topbar-admin" : ""}`}>
                <Link to="/" className="brand">
                    CVC
                </Link>
                <nav className="nav" aria-label="Main">
                    {nav("/", "files", "Files")}
                    {nav("/locks", "locks", "Checked out")}
                    {nav("/activity", "activity", "Activity")}
                    {canUseAdminMode(vault) && nav("/admin", "admin", "Admin")}
                </nav>
                <div className="topbar-end">
                    {canUseAdminMode(vault) && (
                        <label
                            className="check admin-switch"
                            title="Show overrides: release check-outs and force reverts"
                        >
                            <input
                                type="checkbox"
                                checked={adminMode}
                                onChange={(event) => setAdminMode(event.target.checked)}
                            />{" "}
                            Admin mode
                        </label>
                    )}
                    <span className="me">{vault.me?.name}</span>
                    <form method="post" action="/auth/logout">
                        <button type="submit" className="button-small">
                            Sign out
                        </button>
                    </form>
                </div>
            </header>
            {adminMode && (
                <div className="admin-banner" role="status">
                    Admin mode is on: you can release other people's check-outs and revert files they have checked out.
                </div>
            )}
            <main>
                {vault.error && vault.status === "ready" && (
                    <Notice tone="warning">
                        Can't reach the CVC server ({vault.error}). Showing what was here; trying again.
                    </Notice>
                )}
                <Page pathname={pathname} vault={vault} />
            </main>
        </>
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
    if (pathname === "/" || pathname.startsWith("/files")) {
        return <Browse folder={folderFromUrl(pathname)} />;
    }
    switch (pathname.replace(/\/$/, "")) {
        case "/locks":
            return <Locks />;
        case "/activity":
            return <Activity />;
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
