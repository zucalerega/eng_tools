import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Yorg's Python window (admins, on Dev): scripts kept on the server in folders, uploaded as .py files, and the
// examples to start from. The scripts run in the browser with Pyodide, which jsdom can't: here, Python never gets
// ready, and everything else is tested.

test("the Python window is for admins", async () => {
    const team = await Team.create();
    const bob = await team.member("Bob");
    const asBob = renderApp(bob, "/yorg/dev/scripts");
    expect(await screen.findByText(/There's no page here/)).toBeTruthy();
    asBob.unmount();

    renderApp(team.chief, "/yorg/dev");
    await screen.findByRole("heading", { name: "System models" });
    await userEvent.click(
        within(screen.getByRole("navigation", { name: "Dev pages" })).getByRole("link", { name: "Scripts" }),
    );
    expect(await screen.findByRole("heading", { name: "Scripts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true); // no Python here
});

test("scripts are opened from the examples, saved in folders, uploaded, changed, and deleted", async () => {
    const team = await Team.create();
    renderApp(team.chief, "/yorg/dev/scripts");
    const list = within(await screen.findByRole("complementary", { name: "Scripts" }));

    // An example, saved as a script of the team's own, in a folder.
    await userEvent.click(await list.findByRole("button", { name: "Start here: plot a channel" }));
    expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toContain('yorg.channel("PT-TANK")');
    await userEvent.click(screen.getByRole("button", { name: "Save as…" }));
    let dialog = within(screen.getByRole("dialog"));
    await userEvent.clear(dialog.getByLabelText("Name"));
    await userEvent.type(dialog.getByLabelText("Name"), "Tank peak");
    await userEvent.type(dialog.getByLabelText("Folder"), "Hotfires / Tanks");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(list.getByRole("button", { name: "Tank peak" })).toBeTruthy());
    expect(list.getByRole("button", { name: "▾ Hotfires" })).toBeTruthy();
    expect(list.getByRole("button", { name: "▾ Tanks" })).toBeTruthy();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("Hotfires/Tanks");

    // Changed and saved again.
    const code = screen.getByLabelText("Code") as HTMLTextAreaElement;
    await userEvent.clear(code);
    await userEvent.type(code, "print(1)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));

    // A .py file uploads as a script, into the folder open.
    const file = new File(["import numpy as np\nprint(np.pi)\n"], "pi check.py", { type: "text/x-python" });
    await userEvent.upload(screen.getByLabelText("Python files"), file);
    await waitFor(() => expect(list.getByRole("button", { name: "pi check" })).toBeTruthy());
    expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toBe("import numpy as np\nprint(np.pi)\n");

    // The first one, opened again, has its change; then deleted.
    await userEvent.click(list.getByRole("button", { name: "Tank peak" }));
    await waitFor(() => expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toBe("print(1)"));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    dialog = within(screen.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(list.queryByRole("button", { name: "Tank peak" })).toBeNull());
    expect(list.getByRole("button", { name: "pi check" })).toBeTruthy();
});
