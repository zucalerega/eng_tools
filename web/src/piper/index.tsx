import { lazy, Suspense } from "react";
import { Notice } from "../components";
import { Link } from "../router";
import "./piper.css";

// Piper: the team's fluid systems, drawn as P&IDs. Its pages live under /piper; the app switcher in the top bar goes
// between it, Vault, and Yorg. Its pages load when one's first opened: the rest of the site never needs the editor.

const DiagramsPage = lazy(() => import("./Diagrams").then((module) => ({ default: module.DiagramsPage })));
const DeletedPage = lazy(() => import("./Diagrams").then((module) => ({ default: module.DeletedPage })));
const EditorPage = lazy(() => import("./Editor").then((module) => ({ default: module.EditorPage })));
const HelpPage = lazy(() => import("./Help").then((module) => ({ default: module.HelpPage })));
const SchemesPage = lazy(() => import("./Schemes").then((module) => ({ default: module.SchemesPage })));

export const PIPER = "Piper";

export const inPiper = (pathname: string): boolean => pathname === "/piper" || pathname.startsWith("/piper/");

/** Piper's mark: a valve in a line, as P&IDs draw one, its ball in the vault's gold, its handle above. */
export function PiperMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 40h11M48 40h11" />
                <path d="M16 28v24l32-24v24z" />
                <path d="M32 40V15M23 15h18" />
            </g>
            <circle className="piper-ball" cx="32" cy="40" r="6.5" />
        </svg>
    );
}

/** Piper's mark as the browser tab's icon: on the top bar's navy, like the others'. */
export const PIPER_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1b33'/>" +
            "<g fill='none' stroke='#fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'>" +
            "<path d='M5 40h11M48 40h11'/><path d='M16 28v24l32-24v24z'/><path d='M32 40V15M23 15h18'/></g>" +
            "<circle cx='32' cy='40' r='6.5' fill='#e0a500' stroke='#0b1b33' stroke-width='2.5' paint-order='stroke'/></svg>",
    );

/** Which of Piper's sections a path is in, for the top bar. */
export const piperSection = (pathname: string): string =>
    pathname.startsWith("/piper/help") ? "help" : pathname.startsWith("/piper/schemes") ? "schemes" : "diagrams";

/** Whether a page is the editor, which takes the whole window. */
export const piperWholeWindow = (pathname: string): boolean => /^\/piper\/diagrams\/\d+\/?$/.test(pathname);

export function PiperPage({ pathname }: { pathname: string }) {
    const page = piperPage(pathname.replace(/\/$/, "") || "/piper");
    if (!page) {
        return (
            <Notice tone="error">
                There&apos;s no page here. <Link to="/piper">Go to the diagrams</Link>
            </Notice>
        );
    }
    return <Suspense fallback={<p className="muted piper-loading">Loading…</p>}>{page}</Suspense>;
}

/** A Piper page by its path, or null if there's none. */
function piperPage(path: string) {
    const match = /^\/piper\/diagrams\/(\d+)$/.exec(path);
    if (match) {
        return <EditorPage key={match[1]} id={Number(match[1])} />;
    }
    // A folder's page is the diagrams' page, in it: it keeps what it's loaded as it goes from one folder to another.
    const folder = /^\/piper\/folders\/(\d+)$/.exec(path);
    if (folder) {
        return <DiagramsPage key="diagrams" folder={Number(folder[1])} />;
    }
    switch (path) {
        case "/piper":
            return <DiagramsPage key="diagrams" folder={null} />;
        case "/piper/deleted":
            return <DeletedPage />;
        case "/piper/help":
            return <HelpPage />;
        case "/piper/schemes":
            return <SchemesPage />;
    }
    return null;
}
