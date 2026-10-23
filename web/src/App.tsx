import { useEffect, useState } from "react";
import { api } from "./api";
import { Dialog, Notice, usePopover } from "./components";
import { inPreview, PREVIEW, sitePath } from "./preview";
import { inPiper, PIPER, PIPER_ICON, PiperMark, PiperPage, piperSection, piperWholeWindow } from "./piper";
import { Link, navigate, usePathname } from "./router";
import { useSession, useSessionStore } from "./session";
import { setTheme, useTheme, type Theme } from "./theme";
import { inVault, movedToVault, VAULT, VaultMark, VaultPage, vaultSection, wholeWindow, withFolderTree } from "./vault";
import { canUseAdminMode, setAdminMode, useAdminMode } from "./vault/admin";
import { useStore, useVault, type VaultState } from "./vault/store";
import { inYorg, isWorkspace, YORG, YORG_ICON, YorgMark, YorgPage, yorgSection } from "./yorg";

const SITE = "YJSP";
// The site's own icon, as on the sign-in pages (the server's signin.py): the gold orbit both marks take from the
// team's logo, on the top bar's navy.
const SITE_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1b33'/>" +
            "<path d='M4 57Q42 52 60 5Q36 45 4 57Z' fill='#e0a500'/></svg>",
    );
let vaultIcon: string | null = null; // the tab's icon from index.html, put back on coming back to Vault

const THEMES: [Theme, string][] = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
];

export function App() {
    const { me } = useSession();
    const store = useStore();
    const vault = useVault();
    const pathname = usePathname();
    const adminMode = useAdminMode(vault);
    // Three apps share the site and its sign-in: Vault (the CAD files, under /vault), Yorg (test data, under /yorg), and
    // Piper (P&IDs, under /piper). The site's own page, at / (Home), goes to any of them. Yorg's preview (/yorg/dev,
    // admins) is Yorg as it will be, with what's new in its top bar too.
    const yorg = inYorg(pathname);
    const vaultApp = inVault(pathname);
    const piperApp = inPiper(pathname);
    const preview = inPreview(pathname) && me?.is_admin === true;
    // A link from before Vault moved under /vault goes on to the same page there, with its query.
    const moved = movedToVault(pathname);
    useEffect(() => {
        if (moved !== null) {
            navigate(moved + window.location.search + window.location.hash, { replace: true, exact: true });
        }
    }, [moved]);
    // Vault's index loads when a page of the vault first shows, and keeps current only while one does: elsewhere,
    // nothing asks for it.
    useEffect(() => {
        if (vaultApp) {
            store.start();
        } else {
            store.stop();
        }
    }, [vaultApp, store]);
    useEffect(() => {
        document.title = yorg ? YORG : vaultApp ? "Vault" : piperApp ? PIPER : SITE;
        const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (icon) {
            vaultIcon ??= icon.getAttribute("href");
            icon.setAttribute(
                "href",
                yorg ? YORG_ICON : vaultApp ? (vaultIcon ?? "") : piperApp ? PIPER_ICON : SITE_ICON,
            );
        }
    }, [yorg, vaultApp, piperApp]);
    if (moved !== null) {
        return null; // for the moment it takes to go on to the page's new address
    }
    const section = yorg
        ? yorgSection(pathname)
        : vaultApp
          ? vaultSection(pathname)
          : piperApp
            ? piperSection(pathname)
            : "";
    const nav = (to: string, name: string, label: string) => (
        <Link to={to} aria-current={section === name ? "page" : undefined}>
            {label}
        </Link>
    );
    return (
        <>
            <header className={`topbar ${adminMode && vaultApp ? "topbar-admin" : ""}`}>
                {/* The app's mark, but always home to the site's front page, where all the apps are. */}
                <Link to="/" className="brand" aria-label={`${SITE} home`}>
                    {yorg ? <YorgMark /> : vaultApp ? <VaultMark /> : piperApp ? <PiperMark /> : <SiteMark />}
                </Link>
                <nav className="apps" aria-label="Apps">
                    <Link to={VAULT} className="wordmark" aria-current={vaultApp ? "page" : undefined}>
                        Vault
                    </Link>
                    <Link to="/yorg" className="wordmark" aria-current={yorg ? "page" : undefined}>
                        {YORG}
                    </Link>
                    <Link to="/piper" className="wordmark" aria-current={piperApp ? "page" : undefined}>
                        {PIPER}
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
                            {me?.is_admin && !preview && (
                                <Link
                                    to={PREVIEW}
                                    className="preview-link"
                                    title="Yorg as it will be with what's new: only admins see it"
                                >
                                    Preview
                                </Link>
                            )}
                        </>
                    ) : vaultApp ? (
                        <>
                            {nav(VAULT, "files", "Files")}
                            {nav(`${VAULT}/assemblies`, "assemblies", "Assemblies")}
                            {nav(`${VAULT}/locks`, "locks", "Checked out")}
                            {nav(`${VAULT}/activity`, "activity", "Activity")}
                            {nav(`${VAULT}/solidworks`, "solidworks", "SolidWorks")}
                        </>
                    ) : (
                        piperApp && (
                            <>
                                {nav("/piper", "diagrams", "Diagrams")}
                                {nav("/piper/help", "help", "Help")}
                            </>
                        )
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
            {adminMode && vaultApp && (
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
            ) : vaultApp ? (
                <main
                    className={wholeWindow(pathname) ? "main-full" : withFolderTree(pathname) ? "main-wide" : undefined}
                >
                    <VaultPage pathname={pathname} />
                </main>
            ) : piperApp ? (
                <main className={piperWholeWindow(pathname) ? "main-full" : undefined}>
                    <PiperPage pathname={pathname} />
                </main>
            ) : (
                <main>
                    <Home pathname={pathname} />
                </main>
            )}
        </>
    );
}

/** The site's own mark: the gold orbit both apps' marks take from the team's logo. */
function SiteMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <path className="vault-orbit" d="M4 57Q42 52 60 5Q36 45 4 57Z" />
        </svg>
    );
}

/** The site's own page, at its address alone: its apps, to go to any of them. */
function Home({ pathname }: { pathname: string }) {
    return (
        <section className="home">
            {pathname !== "/" && <Notice tone="error">There's no page here.</Notice>}
            <h1>YJSP Engineering Tools Repository</h1>
            <div className="home-apps">
                <Link to={VAULT} className="home-app">
                    <VaultMark size={44} />
                    <span className="home-app-name">Vault</span>
                </Link>
                <Link to="/yorg" className="home-app">
                    <YorgMark size={44} />
                    <span className="home-app-name">{YORG}</span>
                </Link>
                <Link to="/piper" className="home-app">
                    <PiperMark size={44} />
                    <span className="home-app-name">{PIPER}</span>
                </Link>
            </div>
        </section>
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
    const { me } = useSession();
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
                            <Link to={`${VAULT}/admin`} className="menu-item" onClick={() => setOpen(false)}>
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
    const session = useSessionStore();
    const store = useStore();
    const [name, setName] = useState(now);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    async function save() {
        setBusy(true);
        try {
            session.updateMe(await api.renameMe(name.trim()));
            void store.refresh(); // your name on files and check-outs, too (if the vault's open)
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
