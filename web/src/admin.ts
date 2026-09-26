import { useSyncExternalStore } from "react";
import type { VaultState } from "./store";

// Admin mode shows the overrides: releasing someone's check-out and reverting a file they have
// checked out. It's off by default, remembered per browser, and offered to admins and folder leads.

const KEY = "cvc.adminMode";
const listeners = new Set<() => void>();

function stored(): boolean {
    try {
        return window.localStorage.getItem(KEY) === "on";
    } catch {
        return false; // storage blocked: admin mode just doesn't stick
    }
}

let on = stored();

export function setAdminMode(value: boolean): void {
    on = value;
    try {
        window.localStorage.setItem(KEY, value ? "on" : "off");
    } catch {
        // see stored()
    }
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useAdminMode(vault: VaultState): boolean {
    const wanted = useSyncExternalStore(subscribe, () => on);
    return wanted && canUseAdminMode(vault);
}

export function canUseAdminMode(vault: VaultState): boolean {
    if (vault.me?.is_admin || vault.rootRole === "lead") {
        return true;
    }
    for (const folder of vault.folders.values()) {
        if (folder.role === "lead") {
            return true;
        }
    }
    return false;
}
