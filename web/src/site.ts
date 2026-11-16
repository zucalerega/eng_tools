// Whose site it is (the server's YJSP_SITE_NAME and YJSP_TEAM_NAME), as the page says in its meta tags (api/web.py): the
// top bar, the tab, the home page, and a P&ID's title block say them. YJSP's where the page says none (the tests).

function said(name: string): string {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
}

/** The site's short name: "YJSP". */
export function siteName(): string {
    return said("yjsp-site") || "YJSP";
}

/** The team's name: "Yellow Jacket Space Program". */
export function teamName(): string {
    return said("yjsp-team") || "Yellow Jacket Space Program";
}

/** Whether the server has a logo for the team (it serves it at /brand/): a team that hasn't put one there yet has its
 * site's name in the logo's place. */
export function hasLogo(): boolean {
    return said("yjsp-logo") !== "none";
}
