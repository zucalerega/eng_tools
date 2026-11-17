// A stand-in for systemctl, as the test server asks it to start yjsp-deploy.service (YJSP_DEPLOY_SYSTEMCTL): it notes
// what it was asked in the deploy folder (its first argument), as systemctl.log, and begins a deploy as yjsp-deploy does,
// its record there saying it's fetching main. The test then carries the deploy on, as yjsp-deploy would.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [folder, ...asked] = process.argv.slice(2);
appendFileSync(join(folder, "systemctl.log"), JSON.stringify(asked) + "\n");
const now = new Date().toISOString(); // 2026-11-16T19:30:00.123Z
const id = now.slice(0, 19).replace(/[-:]/g, "").replace("T", "-"); // 20261116-193000
mkdirSync(join(folder, "deploys"), { recursive: true });
writeFileSync(join(folder, "deploys", `${id}.log`), "==> Fetching main from GitHub\n");
writeFileSync(
    join(folder, "deploys", `${id}.json`),
    JSON.stringify({ source: "site", started: `${now.slice(0, 19)}Z`, step: "fetch" }),
);
