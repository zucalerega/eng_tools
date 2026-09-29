import { Notice } from "../components";
import { Link } from "../router";
import { useVault } from "../store";
import { DatasetsPage } from "./Datasets";
import { DevPage } from "./dev/DevPage";
import { HelpPage } from "./Help";
import { AboutPage, DatasetPage, DeletedPage, ViewPage, ViewsPage } from "./pages";
import "./yorg.css";

// Yorg: test data, plotted. Its pages live under /yorg; the app switcher in the top bar goes between it and the vault.

export const YORG = "Yorg";

export const inYorg = (pathname: string): boolean => pathname === "/yorg" || pathname.startsWith("/yorg/");

/** Yorg's mark: a signal rising across a pair of axes, to its gold peak (the vault's gold). */
export function YorgMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7v48h48" strokeWidth="5" />
                <path d="M17 45l8-13 8 7 9-20 7 10 6-5" strokeWidth="4" />
            </g>
            <circle className="yorg-peak" cx="42" cy="19" r="5.5" />
        </svg>
    );
}

/** Yorg's mark as the browser tab's icon: on the top bar's navy, like the vault's (index.html). */
export const YORG_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1b33'/>" +
            "<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>" +
            "<path d='M9 7v48h48' stroke-width='5'/><path d='M17 45l8-13 8 7 9-20 7 10 6-5' stroke-width='4'/></g>" +
            "<circle cx='42' cy='19' r='5.5' fill='#e0a500'/></svg>",
    );

/** Which of Yorg's sections a path is in, for the top bar. */
export function yorgSection(pathname: string): string {
    return pathname.startsWith("/yorg/views")
        ? "views"
        : pathname.startsWith("/yorg/help")
          ? "help"
          : pathname.startsWith("/yorg/dev")
            ? "dev"
            : "data";
}

/** Whether a page is a workspace of plots, which takes the whole window. */
export function isWorkspace(pathname: string): boolean {
    return /^\/yorg\/(datasets\/\d+|views\/\d+)\/?$/.test(pathname);
}

export function YorgPage({ pathname }: { pathname: string }) {
    const vault = useVault();
    const path = pathname.replace(/\/$/, "") || "/yorg";
    let match = /^\/yorg\/datasets\/(\d+)$/.exec(path);
    if (match) {
        return <DatasetPage key={match[1]} id={Number(match[1])} />;
    }
    match = /^\/yorg\/datasets\/(\d+)\/about$/.exec(path);
    if (match) {
        return <AboutPage key={match[1]} id={Number(match[1])} />;
    }
    match = /^\/yorg\/folders\/(\d+)$/.exec(path);
    if (match) {
        return <DatasetsPage key={match[1]} folder={Number(match[1])} />;
    }
    match = /^\/yorg\/views\/(\d+)$/.exec(path);
    if (match) {
        return <ViewPage key={match[1]} id={Number(match[1])} />;
    }
    switch (path) {
        case "/yorg":
            return <DatasetsPage key="top" folder={null} />;
        case "/yorg/views":
            return <ViewsPage />;
        case "/yorg/deleted":
            return <DeletedPage />;
        case "/yorg/help":
            return <HelpPage />;
        case "/yorg/dev": // for admins
            if (!vault.me) {
                return <p className="muted">Loading…</p>;
            }
            if (vault.me.is_admin) {
                return <DevPage />;
            }
            break;
    }
    return (
        <Notice tone="error">
            There's no page here. <Link to="/yorg">Go to the test data</Link>
        </Notice>
    );
}
