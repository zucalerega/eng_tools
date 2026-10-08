import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

test("the SolidWorks page has the add-in's installer, and connects SolidWorks to this vault", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/vault/solidworks");

    const installer = await screen.findByRole("link", { name: "Download Vault-Setup.exe" });
    expect(installer.getAttribute("href")).toMatch(/\/api\/downloads\/Vault-Setup\.exe$/);
    const connect = screen.getByRole("link", { name: "Connect SolidWorks" });
    // cvc:// until every laptop has the 0.4.0 add-in, which follows vault:// too (LINK_SCHEME)
    expect(connect.getAttribute("href")).toBe("cvc://connect?server=" + encodeURIComponent(window.location.origin));
    expect(screen.getByRole("link", { name: "vault.exe" })).toBeTruthy(); // the other downloads

    // What to do when the tab doesn't show up, and the rest, open when asked.
    const missing = screen.getByText("There's no Vault tab in SolidWorks").closest("details")!;
    expect(missing.open).toBe(false);
    await userEvent.click(within(missing).getByText("There's no Vault tab in SolidWorks"));
    expect(missing.open).toBe(true);
    expect(missing.textContent).toContain("Tools > Add-ins");
});
