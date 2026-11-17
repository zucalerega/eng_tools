import { lazy, Suspense } from "react";
import { Notice } from "../components";
import { Link } from "../router";
import "./buildflow.css";

// Buildflow: each program's bill of design, its components on the vehicle and their progress through design, build,
// test, and launch; and the shop, the parts queued to be machined and who can run each machine. Its pages live under
// /buildflow; the app switcher in the top bar goes between it and the others. Its pages load when one's first opened.

const ProgramsPage = lazy(() => import("./Programs").then((module) => ({ default: module.ProgramsPage })));
const ProgramPage = lazy(() => import("./Program").then((module) => ({ default: module.ProgramPage })));
const LayoutPage = lazy(() => import("./Layout").then((module) => ({ default: module.LayoutPage })));
const ReviewPage = lazy(() => import("./Review").then((module) => ({ default: module.ReviewPage })));
const HelpPage = lazy(() => import("./Help").then((module) => ({ default: module.HelpPage })));
const ShopPage = lazy(() => import("./Shop").then((module) => ({ default: module.ShopPage })));

export const BUILDFLOW = "Buildflow";

export const inBuildflow = (pathname: string): boolean =>
    pathname === "/buildflow" || pathname.startsWith("/buildflow/");

/** Buildflow's mark: a rocket, a component on it in the vault's gold. */
export function BuildflowMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="vault-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M32 5c-7 7-10 16-10 27v19h20V32c0-11-3-20-10-27z" />
                <path d="M22 40l-9 9v8h9M42 40l9 9v8h-9" />
            </g>
            <circle className="buildflow-dot" cx="32" cy="30" r="6" />
        </svg>
    );
}

/** Buildflow's mark as the browser tab's icon: on the top bar's navy, like the others'. */
export const BUILDFLOW_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1b33'/>" +
            "<g fill='none' stroke='#fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'>" +
            "<path d='M32 5c-7 7-10 16-10 27v19h20V32c0-11-3-20-10-27z'/><path d='M22 40l-9 9v8h9M42 40l9 9v8h-9'/></g>" +
            "<circle cx='32' cy='30' r='6' fill='#e0a500' stroke='#0b1b33' stroke-width='2.5' paint-order='stroke'/></svg>",
    );

/** Which of Buildflow's sections a path is in, for the top bar. */
export const buildflowSection = (pathname: string): string =>
    pathname.startsWith("/buildflow/help") ? "help" : pathname.startsWith("/buildflow/shop") ? "shop" : "programs";

/** Whether a page wants the room: a program's bill, wide with its milestones, and the shop, with its queue. */
export const buildflowWide = (pathname: string): boolean =>
    /^\/buildflow\/programs\/\d+(\/layout)?\/?$/.test(pathname) ||
    /^\/buildflow\/shop(\/skills|\/machines)?\/?$/.test(pathname);

export function BuildflowPage({ pathname }: { pathname: string }) {
    const page = buildflowPage(pathname.replace(/\/$/, "") || "/buildflow");
    if (!page) {
        return (
            <Notice tone="error">
                There&apos;s no page here. <Link to="/buildflow">Go to the programs</Link>
            </Notice>
        );
    }
    return <Suspense fallback={<p className="muted">Loading…</p>}>{page}</Suspense>;
}

/** A Buildflow page by its path, or null if there's none. */
function buildflowPage(path: string) {
    const program = /^\/buildflow\/programs\/(\d+)$/.exec(path);
    if (program) {
        return <ProgramPage key={program[1]} id={Number(program[1])} />;
    }
    const layout = /^\/buildflow\/programs\/(\d+)\/layout$/.exec(path);
    if (layout) {
        return <LayoutPage key={layout[1]} id={Number(layout[1])} />;
    }
    const review = /^\/buildflow\/programs\/(\d+)\/reviews\/(\d+)$/.exec(path);
    if (review) {
        return <ReviewPage key={review[2]} programId={Number(review[1])} id={Number(review[2])} />;
    }
    switch (path) {
        case "/buildflow":
            return <ProgramsPage />;
        case "/buildflow/help":
            return <HelpPage />;
        case "/buildflow/shop":
            return <ShopPage section="queue" />;
        case "/buildflow/shop/skills":
            return <ShopPage section="skills" />;
        case "/buildflow/shop/machines":
            return <ShopPage section="machines" />;
    }
    return null;
}
