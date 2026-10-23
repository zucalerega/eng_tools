import { useLayoutEffect, type RefObject } from "react";

/** Caliper's pages take the rest of the window, under the top bar, however tall that is (it wraps on a phone). */
export function useBelowTopBar(page: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        const element = page.current;
        if (!element) {
            return;
        }
        const place = () =>
            element.style.setProperty("--caliper-top", `${element.getBoundingClientRect().top + window.scrollY}px`);
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    });
}
