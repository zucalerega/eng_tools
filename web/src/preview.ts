// Yorg's preview (/yorg/dev/...): the site as it will be with what's new in it, for admins to try before everyone has
// it. Its pages are Yorg's own, under /yorg/dev (/yorg/dev/datasets/5 is /yorg/datasets/5), with the new ones
// (Models, Scripts) where they'll be; a link followed in the preview stays in it.

export const PREVIEW = "/yorg/dev";

/** Whether a path (or a link's, with its query) is in the preview. */
export const inPreview = (path: string): boolean =>
    path === PREVIEW || path.startsWith(`${PREVIEW}/`) || path.startsWith(`${PREVIEW}?`);

/** A preview path as the site's own: /yorg/dev/datasets/5 is /yorg/datasets/5. */
export function sitePath(path: string): string {
    return inPreview(path) ? `/yorg${path.slice(PREVIEW.length)}` : path;
}

/** A path of Yorg's, in the preview (other paths, the vault's, as they are). */
export function previewPath(to: string): string {
    if (inPreview(to)) {
        return to;
    }
    return to === "/yorg" || to.startsWith("/yorg/") || to.startsWith("/yorg?") ? `${PREVIEW}${to.slice(5)}` : to;
}

/** Where a link goes from the page open now: in the preview, Yorg's links stay in it. */
export function linkTarget(to: string): string {
    return inPreview(window.location.pathname) ? previewPath(to) : to;
}
