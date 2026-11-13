export function normalizeSequenceName(value: string): string {
    const base = String(value ?? "")
        .trim()
        .replace(/\.py$/i, "");
    const safe = base
        .replace(/[^a-zA-Z0-9 _.-]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._-]+/, "")
        .slice(0, 72)
        .replace(/[._-]+$/, "");
    return safe || "sequence";
}

export function sequenceFileName(value: string): string {
    return `${normalizeSequenceName(value)}.py`;
}

export function environmentFileName(value: string): string {
    return `${normalizeSequenceName(value)}-environment.json`;
}
