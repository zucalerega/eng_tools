const UNITS = ["bytes", "KB", "MB", "GB"];

export function formatSize(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return unit === 0 ? `${value} ${UNITS[0]}` : `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const SPANS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["week", 7 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
];

/** "5 minutes ago", "yesterday". */
export function formatAgo(iso: string, now: number = Date.now()): string {
    const seconds = (new Date(iso).getTime() - now) / 1000;
    for (const [unit, span] of SPANS) {
        if (Math.abs(seconds) >= span) {
            return RELATIVE.format(Math.round(seconds / span), unit);
        }
    }
    return "just now";
}

/** "Sep 26, 2026, 4:49 PM", in this computer's time zone. */
export function formatTime(iso: string): string {
    return new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

export function formatDay(iso: string): string {
    return new Date(iso).toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
