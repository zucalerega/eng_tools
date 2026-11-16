// Where the site is: "" at the root of its address, or a path like /demo, for the demo, which the main site passes on to
// it (docs/design.md, "The demo"). The server says it in a meta tag on the page (YJSP_ROOT_PATH, api/web.py). The app's
// own paths (/vault/file/12) are the same wherever the site is: the router, requests to the server, and links to its
// own pages (the help, the team's logo) put the root in front of them.

const SHAPE = /^(\/[A-Za-z0-9._~-]+)*$/;

/** The site's root, from the page: "" if it says none. */
export function root(): string {
    const said = document.querySelector('meta[name="yjsp-root"]')?.getAttribute("content") ?? "";
    return SHAPE.test(said) ? said : "";
}

/** A path on the site, like /help, as the browser reaches it: /demo/help in the demo. */
export function onSite(path: string): string {
    return root() + path;
}

/** The app's path for one the browser is at: /vault for /demo/vault in the demo. */
export function inApp(pathname: string): string {
    const at = root();
    if (!at) {
        return pathname;
    }
    if (pathname === at) {
        return "/";
    }
    return pathname.startsWith(at + "/") ? pathname.slice(at.length) : pathname;
}

/** Point the stylesheet at the team's logo where the server has it (styles.css, --logo-on-light, --logo-on-dark). */
export function placeLogos(): void {
    const at = root();
    if (at) {
        const style = document.documentElement.style;
        style.setProperty("--logo-on-light", `url("${at}/brand/logo-on-light.png")`);
        style.setProperty("--logo-on-dark", `url("${at}/brand/logo-on-dark.png")`);
    }
}
