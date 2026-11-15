import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Deal, type DealsStatus } from "./api";
import { Notice, Time } from "./components";
import { Link } from "./router";

// Deals on eBay for what the team wants (server: deals/): on the site's own page, as cards that slide by, each saying
// what it's for, with a link to that on its app's page; and beside each component on a program's bill of design
// (web/src/buildflow). Admins see how the finder's doing, and start a search, on Admin > Deals.

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A price, in dollars: $45.00. */
export const money = (amount: number) => dollars.format(amount);

/** What shipping adds, in words. */
function shipping(deal: Deal): string {
    if (deal.shipping === null) {
        return "+ shipping";
    }
    return deal.shipping === 0 ? "free shipping" : `+ ${money(deal.shipping)} shipping`;
}

/** A deal: the listing's picture, title, and price, what it's for on the site, why it would do, and how old it is. */
export function DealCard({
    deal,
    onDismiss,
    compact = false,
}: {
    deal: Deal;
    onDismiss: () => void;
    compact?: boolean;
}) {
    const under = deal.savings !== null && deal.savings >= 0.1 ? Math.round(deal.savings * 100) : null;
    return (
        <article className={`deal-card ${compact ? "deal-card-compact" : ""}`} aria-label={deal.title}>
            <a className="deal-picture" href={deal.url} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
                {deal.image ? (
                    <img src={deal.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                    <span className="deal-no-picture" aria-hidden="true">
                        eBay
                    </span>
                )}
                {under !== null && !compact && <span className="deal-under">{under}% under typical</span>}
            </a>
            <div className="deal-body">
                <a className="deal-title" href={deal.url} target="_blank" rel="noopener noreferrer" title={deal.title}>
                    {deal.title}
                </a>
                <p className="deal-price">
                    <strong>{money(deal.price)}</strong> <span className="muted">{shipping(deal)}</span>
                    {under !== null && compact && <span className="deal-under-inline">{under}% under typical</span>}
                </p>
                <p className="deal-kind muted">
                    {deal.condition || "Condition not said"}
                    {deal.auction && deal.ends_at && (
                        <>
                            {" · Auction, ends "}
                            <Time at={deal.ends_at} />
                        </>
                    )}
                </p>
                {!compact && (
                    <p className="deal-for">
                        For <Link to={deal.want_href}>{deal.want_title}</Link>
                        <span className="muted"> · {deal.want_where}</span>
                    </p>
                )}
                {deal.reason && <p className="deal-why">{deal.reason}</p>}
                <p className="deal-age muted">
                    On eBay, checked <Time at={deal.checked_at} />
                </p>
                <div className="deal-foot">
                    <a href={deal.url} target="_blank" rel="noopener noreferrer">
                        View on eBay ↗
                    </a>
                    <button
                        type="button"
                        className="deal-dismiss"
                        aria-label={`Not useful: hide ${deal.title}`}
                        title="Not useful: hide it, and don't find it again for this"
                        onClick={onDismiss}
                    >
                        ✕
                    </button>
                </div>
            </div>
        </article>
    );
}

/** Deals that can be hidden, and brought back from where they were hidden. */
function useDeals() {
    const [deals, setDeals] = useState<Deal[] | null>(null);
    const [hidden, setHidden] = useState<Set<number>>(new Set());
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.deals().then(setDeals, () => setDeals([]));
    }, []);
    const hide = async (deal: Deal, dismissed: boolean) => {
        setProblem(null);
        try {
            await api.dismissDeal(deal.id, dismissed);
            setHidden((now) => {
                const next = new Set(now);
                if (dismissed) {
                    next.add(deal.id);
                } else {
                    next.delete(deal.id);
                }
                return next;
            });
        } catch (error) {
            setProblem(message(error));
        }
    };
    return { deals, hidden, hide, problem };
}

const SLIDE_EVERY_MS = 6000;

/**
 * The site's own page's deals, at its foot: cards that slide by on their own every few seconds (not while the pointer
 * or the keyboard is on them, nor for people who'd rather nothing moved), and with the arrows. Nothing, if there are
 * none.
 */
export function HomeDeals() {
    const { deals, hidden, hide, problem } = useDeals();
    const strip = useRef<HTMLDivElement>(null);
    const [held, setHeld] = useState(false);
    const slide = useCallback((by: number) => {
        const row = strip.current;
        const card = row?.querySelector<HTMLElement>(".deal-slot");
        if (!row || !card) {
            return;
        }
        const step = card.offsetWidth + 16;
        const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
        if (by > 0 && atEnd) {
            row.scrollTo?.({ left: 0, behavior: "smooth" });
        } else {
            row.scrollBy?.({ left: by * step, behavior: "smooth" });
        }
    }, []);
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    useEffect(() => {
        if (held || still || !deals || deals.length < 2) {
            return;
        }
        const timer = setInterval(() => slide(1), SLIDE_EVERY_MS);
        return () => clearInterval(timer);
    }, [held, still, deals, slide]);
    if (!deals || deals.length === 0) {
        return null;
    }
    const newest = deals.reduce((at, deal) => (deal.checked_at > at ? deal.checked_at : at), deals[0]!.checked_at);
    return (
        <section className="home-deals" aria-label="Deals">
            <div className="home-deals-head">
                <h2>Deals for the team</h2>
                <span className="muted home-deals-said">
                    On eBay, for what&apos;s being designed and built, checked <Time at={newest} />
                </span>
                <span className="home-deals-arrows">
                    <button type="button" className="button-small" aria-label="Earlier deals" onClick={() => slide(-1)}>
                        ‹
                    </button>
                    <button type="button" className="button-small" aria-label="Later deals" onClick={() => slide(1)}>
                        ›
                    </button>
                </span>
            </div>
            {problem && <Notice tone="error">{problem}</Notice>}
            <div
                className="home-deals-strip"
                ref={strip}
                onMouseEnter={() => setHeld(true)}
                onMouseLeave={() => setHeld(false)}
                onFocus={() => setHeld(true)}
                onBlur={() => setHeld(false)}
            >
                {deals.map((deal) => (
                    <div key={deal.id} className="deal-slot">
                        {hidden.has(deal.id) ? (
                            <div className="deal-hidden">
                                <p>Hidden: it won&apos;t be shown, or found again, for {deal.want_title}.</p>
                                <button type="button" className="button-small" onClick={() => void hide(deal, false)}>
                                    Undo
                                </button>
                            </div>
                        ) : (
                            <DealCard deal={deal} onDismiss={() => void hide(deal, true)} />
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

const RUNNING_EVERY_MS = 2000;

/** Admin > Deals: whether the finder's set up, its runs, and a search now. */
export function DealsAdmin() {
    const [status, setStatus] = useState<DealsStatus | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const reload = useCallback(async () => {
        try {
            setStatus(await api.dealsStatus());
        } catch (error) {
            setProblem(message(error));
        }
    }, []);
    useEffect(() => {
        void reload();
    }, [reload]);
    // While a run's going, until it's done.
    useEffect(() => {
        if (!status?.running) {
            return;
        }
        const timer = setTimeout(() => void reload(), RUNNING_EVERY_MS);
        return () => clearTimeout(timer);
    }, [status, reload]);
    async function search() {
        setProblem(null);
        try {
            setStatus(await api.searchDeals());
        } catch (error) {
            setProblem(message(error));
        }
    }
    if (!status) {
        return problem ? <Notice tone="error">{problem}</Notice> : <p className="muted">Loading…</p>;
    }
    return (
        <section className="deals-admin">
            <p className="muted">
                The deals finder searches eBay once a day for what the team wants: Buildflow&apos;s components not yet
                procured (by their part numbers, or the stock they&apos;re made from), vendors&apos; parts in Vault that
                everyone can see, and parts on Piper&apos;s P&IDs that say their model. It keeps the listings that would
                do{status.claude ? ", as Claude says," : ""} and checks those shown every four hours, as eBay&apos;s
                terms ask: nothing older than six hours is shown.
            </p>
            {!status.available && <Notice tone="warning">{status.reason}</Notice>}
            {problem && <Notice tone="error">{problem}</Notice>}
            {status.available && (
                <div className="deals-admin-head">
                    <p>
                        <strong>{status.shown}</strong> deals shown.{" "}
                        {status.running
                            ? `A ${status.running} is going now.`
                            : status.next_search && (
                                  <>
                                      Next search <Time at={status.next_search} />.
                                  </>
                              )}{" "}
                        {status.claude
                            ? "Claude says which listings would do."
                            : "Their words alone say which would do."}
                    </p>
                    <button
                        type="button"
                        className="button-primary"
                        disabled={status.running !== null}
                        onClick={() => void search()}
                    >
                        {status.running ? "Searching…" : "Search now"}
                    </button>
                </div>
            )}
            <h2>Runs</h2>
            {status.runs.length === 0 ? (
                <p className="muted">None yet.</p>
            ) : (
                <div className="table-scroll">
                    <table className="table" aria-label="Runs">
                        <thead>
                            <tr>
                                <th>Started</th>
                                <th>What</th>
                                <th>By</th>
                                <th className="numeric">Wanted</th>
                                <th className="numeric">Calls</th>
                                <th className="numeric">Listings</th>
                                <th className="numeric">Shown</th>
                                <th className="numeric">Gone</th>
                                <th>Claude</th>
                                <th>Problem</th>
                            </tr>
                        </thead>
                        <tbody>
                            {status.runs.map((run) => (
                                <tr key={run.id}>
                                    <td>
                                        <Time at={run.started_at} />
                                    </td>
                                    <td>
                                        {run.kind === "search" ? "Search" : "Check"}
                                        {run.finished_at === null && " (going)"}
                                    </td>
                                    <td>{run.started_by?.name ?? "On schedule"}</td>
                                    <td className="numeric">{run.kind === "search" ? run.wants : ""}</td>
                                    <td className="numeric">{run.searches}</td>
                                    <td className="numeric">{run.listings}</td>
                                    <td className="numeric">{run.found}</td>
                                    <td className="numeric">{run.gone}</td>
                                    <td>{run.judged ? money(run.cost) : ""}</td>
                                    <td className="deals-problem">{run.problem ?? ""}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
