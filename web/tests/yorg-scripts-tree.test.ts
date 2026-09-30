import { describe, expect, test } from "vitest";
import { EXAMPLES } from "../src/yorg/scripts/examples";
import { folderTree, nameOfFile, namedChannels, quoted, tidyFolder } from "../src/yorg/scripts/tree";

// The Python window's bookkeeping: scripts in folders, and the channels a script names.

describe("folders", () => {
    test("scripts go in a tree of their folders, each in order", () => {
        const tree = folderTree([
            { name: "Tank peak", folder: "Hotfires/Tanks" },
            { name: "Loose", folder: "" },
            { name: "Injector 2", folder: "Hotfires" },
            { name: "Injector 10", folder: "Hotfires" },
            { name: "Chamber", folder: "Hotfires/Chamber" },
        ]);
        expect(tree.items.map((one) => one.name)).toEqual(["Loose"]);
        const [hotfires] = tree.folders;
        expect(hotfires).toMatchObject({ name: "Hotfires", path: "Hotfires" });
        expect(hotfires!.items.map((one) => one.name)).toEqual(["Injector 2", "Injector 10"]);
        expect(hotfires!.folders.map((one) => one.path)).toEqual(["Hotfires/Chamber", "Hotfires/Tanks"]);
    });

    test("the examples keep their own order, Start here first", () => {
        const tree = folderTree(EXAMPLES);
        expect(tree.folders[0]!.items.map((one) => one.name)[0]).toBe("Start here: plot a channel");
        expect(tree.folders[0]!.items.map((one) => one.id)).toEqual(EXAMPLES.map((one) => one.id));
    });

    test("a folder path is tidied as the server tidies it", () => {
        expect(tidyFolder(" Hotfires \\ Tanks// ")).toBe("Hotfires/Tanks");
        expect(tidyFolder("  ")).toBe("");
    });

    test("an uploaded file's name names its script", () => {
        expect(nameOfFile("tank blowdown.py")).toBe("tank blowdown");
        expect(nameOfFile("CHECK.PY")).toBe("CHECK");
        expect(nameOfFile(".py")).toBe("Script");
    });
});

describe("channels a script names", () => {
    test("strings in quotes, either kind, escapes and all", () => {
        expect(quoted(`pt = yorg.channel("PT-TANK")\nfm = yorg.channel('FM-OX')\nprint("say \\"hi\\"")`)).toEqual(
            new Set(["PT-TANK", "FM-OX", 'say \\"hi\\"']),
        );
    });

    test("only the test's own channels are loaded before a script runs", () => {
        const code = `a = yorg.channel("PT-TANK")\nb = yorg.channel("PT-NOT-HERE")\n# "FM-OX" in a comment still counts\nname = "MOV-" + "OX"`;
        expect(namedChannels(code, ["MOV-OX", "PT-TANK", "FM-OX", "TC-01"])).toEqual(["PT-TANK", "FM-OX"]);
    });
});
