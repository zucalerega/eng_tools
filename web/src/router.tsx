import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { linkTarget } from "./preview";

// A small router: the address bar is the state. Links push history entries, and pages read the path. In Yorg's
// preview (preview.ts), links to Yorg's pages go to their preview ones, unless exact.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    window.addEventListener("popstate", listener);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("popstate", listener);
    };
}

export function navigate(to: string, options: { replace?: boolean; exact?: boolean } = {}): void {
    const target = options.exact ? to : linkTarget(to);
    if (options.replace) {
        window.history.replaceState(null, "", target);
    } else {
        window.history.pushState(null, "", target);
    }
    window.scrollTo?.(0, 0);
    listeners.forEach((listener) => listener());
}

/** The current path, like /files/Structures (without the query). */
export function usePathname(): string {
    return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** The current query, like ?version=3: for a page that keeps what it shows there. */
export function useSearch(): string {
    return useSyncExternalStore(subscribe, () => window.location.search);
}

export function Link({
    to,
    exact = false,
    onClick,
    ...props
}: { to: string; exact?: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>) {
    const target = exact ? to : linkTarget(to);
    function follow(event: MouseEvent<HTMLAnchorElement>) {
        onClick?.(event);
        // Let the browser handle new tabs and windows.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
        }
        event.preventDefault();
        navigate(to, { exact }); // where it goes from the page open now
    }
    return <a {...props} href={target} onClick={follow} />;
}
