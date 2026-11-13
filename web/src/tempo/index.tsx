import { lazy, Suspense } from "react";
import { Notice } from "../components";
import { Link } from "../router";
import type { TempoRunner } from "./sandbox";
import "./tempo.css";

const Workspace = lazy(() => import("./Workspace").then((module) => ({ default: module.Workspace })));
const TestsPage = lazy(() => import("./TestsPage").then((module) => ({ default: module.TestsPage })));
const EnvironmentsPage = lazy(() =>
    import("./EnvironmentsPage").then((module) => ({ default: module.EnvironmentsPage })),
);
const HelpPage = lazy(() => import("./HelpPage").then((module) => ({ default: module.HelpPage })));

export const TEMPO = "Tempo";

export const inTempo = (pathname: string): boolean => pathname === "/tempo" || pathname.startsWith("/tempo/");

/** Tempo's mark: a sequence timeline step pulse with a gold timing node. */
export function TempoMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 44h12V20h20v24h16" />
                <path d="M12 54h40" strokeWidth="3.5" opacity="0.55" />
            </g>
            <circle className="tempo-node" cx="40" cy="20" r="6" />
        </svg>
    );
}

/** Tempo's mark as the browser tab's icon: on the top bar's navy, like the others'. */
export const TEMPO_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1b33'/>" +
            "<g fill='none' stroke='#fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'>" +
            "<path d='M8 44h12V20h20v24h16'/></g>" +
            "<circle cx='40' cy='20' r='6' fill='#e0a500' stroke='#0b1b33' stroke-width='2.5' paint-order='stroke'/></svg>",
    );

/** Which of Tempo's sections a path is in, for the top bar. */
export function tempoSection(pathname: string): string {
    for (const section of ["tests", "environments", "help"]) {
        if (pathname.startsWith(`/tempo/${section}`)) {
            return section;
        }
    }
    return "workspace";
}

export const tempoWide = (pathname: string): boolean =>
    pathname.replace(/\/$/, "") === "/tempo" || pathname === "/tempo/";

export function TempoPage({ pathname, createRunner }: { pathname: string; createRunner?: () => TempoRunner }) {
    const path = pathname.replace(/\/$/, "") || "/tempo";
    let page = null;
    switch (path) {
        case "/tempo":
            page = <Workspace createRunner={createRunner} />;
            break;
        case "/tempo/tests":
            page = <TestsPage />;
            break;
        case "/tempo/environments":
            page = <EnvironmentsPage />;
            break;
        case "/tempo/help":
            page = <HelpPage />;
            break;
    }
    if (!page) {
        return (
            <Notice tone="error">
                There&apos;s no page here. <Link to="/tempo">Go to Tempo</Link>
            </Notice>
        );
    }
    return <Suspense fallback={<p className="muted">Loading…</p>}>{page}</Suspense>;
}
