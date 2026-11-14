import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp, Team } from "./team";

// Picking a dataset from the datasets' folders (the site's FolderBrowser), as the datasets page browses them: opened
// in the folder of the dataset it's picked to go with, into a folder and back up by the path, and found in any folder.

const DATA = ["Time (s),PT-TANK (psig)", "0,300", "1,301", "2,299"].join("\n");

const names = (list: HTMLElement) =>
    within(list)
        .getAllByRole("button")
        .map((one) => one.querySelector(".folder-browser-name")?.firstChild?.textContent);

test("comparing picks a dataset from the folders, starting in the first dataset's", async () => {
    const team = await Team.create();
    const campaign = await team.dataFolder(team.chief, "Campaign");
    const day = await team.dataFolder(team.chief, "Day 2", campaign.id);
    const first = await team.data(team.chief, "LOG0001", DATA, campaign.id);
    const sibling = await team.data(team.chief, "LOG0002", DATA, campaign.id);
    const deeper = await team.data(team.chief, "LOG0003", DATA, day.id);
    const top = await team.data(team.chief, "Loose", DATA);
    const user = userEvent.setup();
    renderApp(team.chief, `/yorg/datasets/${first.id}`);
    const channels = within(await screen.findByRole("complementary", { name: "Channels" }));
    await channels.findByRole("button", { name: /PT-TANK/ });

    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    const picker = within(await screen.findByRole("dialog", { name: "Compare with" }));
    // Its folder: its folders, then its datasets, less the one already on the page.
    const where = within(await picker.findByRole("navigation", { name: "Compare with: where" }));
    expect(where.getByText(campaign.name)).toBeTruthy();
    const list = () => picker.getByRole("list");
    await waitFor(() => expect(names(list())).toEqual([day.name, sibling.name]));
    expect(picker.getByRole("button", { name: `${day.name}: folder` }).textContent).toContain("1"); // what's in it

    // Into a folder, and back up to the top by the path.
    await user.click(picker.getByRole("button", { name: `${day.name}: folder` }));
    expect(names(list())).toEqual([deeper.name]);
    await user.click(where.getByRole("button", { name: "Datasets" }));
    expect(names(list())).toContain(campaign.name);
    expect(names(list())).toContain(top.name);

    // Found in any folder by a few words, saying where it is; Enter takes the first.
    await user.type(picker.getByLabelText("Find a dataset"), `log0003 ${team.folder}`);
    expect(names(list())).toEqual([deeper.name]);
    expect(within(list()).getByText(`in ${campaign.name} / ${day.name}`)).toBeTruthy();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Compare with" })).toBeNull();
    expect(await channels.findByText(deeper.name)).toBeTruthy();
    await waitFor(() => expect(channels.getAllByRole("button", { name: /PT-TANK/ })).toHaveLength(2));

    // Opened again, it's back in the first dataset's folder, without what's compared already.
    await user.click(channels.getByRole("button", { name: "Compare with another dataset" }));
    const again = within(await screen.findByRole("dialog", { name: "Compare with" }));
    await waitFor(() => expect(names(again.getByRole("list"))).toEqual([day.name, sibling.name]));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Compare with" })).toBeNull();
});
