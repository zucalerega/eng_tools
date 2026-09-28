import { Notice } from "../components";
import { Link } from "../router";
import { AboutPage, DatasetPage, DatasetsPage, DeletedPage, ViewPage, ViewsPage } from "./pages";
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

/** Which of Yorg's sections a path is in, for the top bar. */
export function yorgSection(pathname: string): string {
    return pathname.startsWith("/yorg/views") ? "views" : "data";
}

/** Whether a page is a workspace of plots, which takes the whole window. */
export function isWorkspace(pathname: string): boolean {
    return /^\/yorg\/(datasets\/\d+|views\/\d+)\/?$/.test(pathname);
}

export function YorgPage({ pathname }: { pathname: string }) {
    const path = pathname.replace(/\/$/, "") || "/yorg";
    let match = /^\/yorg\/datasets\/(\d+)$/.exec(path);
    if (match) {
        return <DatasetPage key={match[1]} id={Number(match[1])} />;
    }
    match = /^\/yorg\/datasets\/(\d+)\/about$/.exec(path);
    if (match) {
        return <AboutPage key={match[1]} id={Number(match[1])} />;
    }
    match = /^\/yorg\/views\/(\d+)$/.exec(path);
    if (match) {
        return <ViewPage key={match[1]} id={Number(match[1])} />;
    }
    switch (path) {
        case "/yorg":
            return <DatasetsPage />;
        case "/yorg/views":
            return <ViewsPage />;
        case "/yorg/deleted":
            return <DeletedPage />;
        default:
            return (
                <Notice tone="error">
                    There's no page here. <Link to="/yorg">Go to the test data</Link>
                </Notice>
            );
    }
}
