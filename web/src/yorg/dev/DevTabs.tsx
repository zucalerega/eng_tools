import { Link, usePathname } from "../../router";

// The dev pages (admins, while they're tried out): system models, and the Python window.

const TABS = [
    { to: "/yorg/dev", label: "System models" },
    { to: "/yorg/dev/scripts", label: "Scripts" },
];

export function DevTabs() {
    const pathname = usePathname().replace(/\/$/, "");
    return (
        <nav className="dev-tabs" aria-label="Dev pages">
            {TABS.map((tab) => (
                <Link key={tab.to} to={tab.to} aria-current={pathname === tab.to ? "page" : undefined}>
                    {tab.label}
                </Link>
            ))}
        </nav>
    );
}
