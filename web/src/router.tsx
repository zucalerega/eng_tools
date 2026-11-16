import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { inApp, onSite } from "./root";

// A small router: the address bar is the state. Links push history entries, and pages read the path. Paths are the
// app's own (/vault/file/12), wherever the site is: under its root (root.ts) in the address bar, as /demo/vault/file/12
// in the demo.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    window.addEventListener("popstate", listener);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("popstate", listener);
    };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
    if (options.replace) {
        window.history.replaceState(null, "", onSite(to));
    } else {
        window.history.pushState(null, "", onSite(to));
    }
    window.scrollTo?.(0, 0);
    listeners.forEach((listener) => listener());
}

/** The current path, like /files/Structures (without the query, or the site's root). */
export function usePathname(): string {
    return useSyncExternalStore(subscribe, () => inApp(window.location.pathname));
}

/** The current query, like ?version=3: for a page that keeps what it shows there. */
export function useSearch(): string {
    return useSyncExternalStore(subscribe, () => window.location.search);
}

export function Link({ to, onClick, ...props }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
    function follow(event: MouseEvent<HTMLAnchorElement>) {
        onClick?.(event);
        // Let the browser handle new tabs and windows.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
        }
        event.preventDefault();
        navigate(to);
    }
    return <a {...props} href={onSite(to)} onClick={follow} />;
}
