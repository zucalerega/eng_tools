import { useEffect, useState } from "react";
import { request } from "../api";
import { onSite, root } from "../root";
import type { LinkKind } from "./api";

// A component's links: what each kind is called, and the ones to the site's own apps (a model in Vault, a P&ID in
// Piper, a test in Yorg), which are kept as their paths and named by what they go to. Buildflow asks each app's API for
// a name as any client would, and imports none of their code.

export const KIND_NAMES: Record<LinkKind, string> = {
    cad: "CAD",
    drawing: "Drawing",
    requirement: "Requirement",
    document: "Design document",
    review: "Review",
    pid: "P&ID",
    data: "Test data",
    procedure: "Procedure",
    other: "Link",
};

export const KINDS = Object.keys(KIND_NAMES) as LinkKind[];

/** Where on the site a link goes: which app, and its file, diagram, or test, if it's one. */
export interface SiteTarget {
    app: "vault" | "piper" | "yorg";
    id: number | null;
}

export function siteTarget(url: string): SiteTarget | null {
    if (!url.startsWith("/")) {
        return null;
    }
    const path = url.split(/[?#]/)[0]!;
    const numbered = (pattern: RegExp) => {
        const found = pattern.exec(path);
        return found ? Number(found[1]) : null;
    };
    if (path === "/vault" || path.startsWith("/vault/")) {
        return { app: "vault", id: numbered(/^\/vault\/file\/(\d+)\/?$/) };
    }
    if (path === "/piper" || path.startsWith("/piper/")) {
        return { app: "piper", id: numbered(/^\/piper\/diagrams\/(\d+)(?:\/parts)?\/?$/) };
    }
    if (path === "/yorg" || path.startsWith("/yorg/")) {
        return { app: "yorg", id: numbered(/^\/yorg\/datasets\/(\d+)\/?$/) };
    }
    return null;
}

/** A link as it's kept: trimmed, and an address on this site as its path, so it works wherever the site is reached. */
export function tidyUrl(url: string): string {
    const trimmed = url.trim();
    const site = window.location.origin + root();
    return trimmed.startsWith(site + "/") ? trimmed.slice(site.length) : trimmed;
}

/** Where a link goes, as the browser reaches it: a path on this site under its root (root.ts), anything else as is. */
export function linkHref(url: string): string {
    return url.startsWith("/") && !url.startsWith("//") ? onSite(url) : url;
}

/** The kind a link most likely is, from where it goes: a model in Vault, a P&ID in Piper, a test in Yorg. */
export function guessKind(url: string): LinkKind | null {
    const target = siteTarget(tidyUrl(url));
    if (!target) {
        return null;
    }
    return target.app === "piper" ? "pid" : target.app === "yorg" ? "data" : "cad";
}

const APP_NAMES: Record<SiteTarget["app"], string> = { vault: "Vault", piper: "Piper", yorg: "Yorg" };

/** The app a link goes to, for its badge. */
export const appName = (target: SiteTarget) => APP_NAMES[target.app];

const names = new Map<string, Promise<string | null>>();

/** The name of what a link on this site goes to, from its app's API: a Vault file's name (with its title), a P&ID's,
 * a test's. Null if it can't be had (gone, or not yours to see). */
function siteName(target: SiteTarget): Promise<string | null> {
    if (target.id === null) {
        return Promise.resolve(null);
    }
    const key = `${target.app}:${target.id}`;
    let found = names.get(key);
    if (!found) {
        const asked =
            target.app === "vault"
                ? request<{ file: { name: string; title?: string } }>("GET", `/api/files/${target.id}`).then(
                      ({ file }) => {
                          // Its title is its name without its type until someone names it: then it says more.
                          const said = file.title && file.title !== file.name.replace(/\.[^.]*$/, "");
                          return said ? `${file.name}, ${file.title}` : file.name;
                      },
                  )
                : target.app === "piper"
                  ? request<{ name: string }>("GET", `/api/piper/diagrams/${target.id}/lock`).then((d) => d.name)
                  : request<{ name: string }>("GET", `/api/yorg/datasets/${target.id}`).then((d) => d.name);
        found = asked.catch(() => null);
        names.set(key, found);
    }
    return found;
}

/** What a link on this site goes to, by name, once its app has said. */
export function useSiteName(url: string): string | null {
    const [name, setName] = useState<string | null>(null);
    useEffect(() => {
        const target = siteTarget(url);
        let current = true;
        setName(null);
        if (target) {
            void siteName(target).then((found) => current && setName(found));
        }
        return () => {
            current = false;
        };
    }, [url]);
    return name;
}
