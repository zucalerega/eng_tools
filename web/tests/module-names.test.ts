import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, test } from "vitest";

// Windows doesn't tell file names apart by case, and the site is built there to be deployed (deploy/deploy.sh): with
// Vehicle.tsx and vehicle.ts side by side, "./Vehicle" found vehicle.ts on Windows, and the build failed, where Linux
// (CI) found the component.
test("no two of the web app's modules differ only in case", () => {
    const src = resolve(import.meta.dirname, "../src");
    const modules = readdirSync(src, { recursive: true, encoding: "utf8" })
        .filter((path) => /\.(ts|tsx)$/.test(path))
        .map((path) =>
            relative(src, resolve(src, path))
                .replaceAll("\\", "/")
                .replace(/\.(ts|tsx)$/, ""),
        );
    const byKey = new Map<string, string[]>();
    for (const module of modules) {
        byKey.set(module.toLowerCase(), [...(byKey.get(module.toLowerCase()) ?? []), module]);
    }
    expect([...byKey.values()].filter((names) => new Set(names).size > 1)).toEqual([]);
});
