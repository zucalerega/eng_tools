import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

// A small router: the address bar is the state. Links push history entries, and pages read the path.

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
        window.history.replaceState(null, "", to);
    } else {
        window.history.pushState(null, "", to);
    }
    window.scrollTo?.(0, 0);
    listeners.forEach((listener) => listener());
}

/** The current path, like /files/Structures (without the query). */
export function usePathname(): string {
    return useSyncExternalStore(subscribe, () => window.location.pathname);
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
    return <a {...props} href={to} onClick={follow} />;
}
