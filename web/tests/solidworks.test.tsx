import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

test("the SolidWorks page has the add-in's installer, and connects SolidWorks to this vault", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/solidworks");

    const installer = await screen.findByRole("link", { name: "Download Vault-Setup.exe" });
    expect(installer.getAttribute("href")).toMatch(/\/api\/downloads\/Vault-Setup\.exe$/);
    const connect = screen.getByRole("link", { name: "Connect SolidWorks" });
    expect(connect.getAttribute("href")).toBe("cvc://connect?server=" + encodeURIComponent(window.location.origin));
    expect(screen.getByRole("link", { name: "cvc.exe" })).toBeTruthy(); // the other downloads
});
