using Vault.Client.Renumbering;

namespace Vault.Client.Tests;

/// <summary>The renumbering's plan (docs/renumbering.md): which file gets which name, from a snapshot of the vault.</summary>
public sealed class RenumberPlanTests
{
    [Fact]
    public void PartsAndAssembliesTakeNumbersInOrder()
    {
        var plan = RenumberPlan.Plan(
            [
                new RenumberFile(4, "Fins/Rail.SLDPRT"),
                new RenumberFile(3, "Fins/Fin.SLDPRT"),
                new RenumberFile(5, "Fins/Fin Can.SLDASM"),
                new RenumberFile(2, "Avionics/Sled.SLDPRT"),
                new RenumberFile(1, "Fins/Notes.txt"), // a document keeps its name, and isn't counted
            ],
            new RenumberRules(),
            22);

        // By folder, then assemblies before parts, then name.
        Assert.Equal(
            ["Avionics/00000022-001.SLDPRT", "Fins/00000023-501.SLDASM", "Fins/00000024-001.SLDPRT", "Fins/00000025-001.SLDPRT"],
            plan.Renames.Select(r => r.NewPath));
        Assert.Equal([2L, 5, 3, 4], plan.Renames.Select(r => r.File.Id));
        Assert.Equal(("Fin", "part"), (plan.Renames[2].Title, plan.Renames[2].Role)); // the title it had
        Assert.Equal(26, plan.NextNumber);
        Assert.Empty(plan.Problems);
    }

    [Fact]
    public void VendorsPartsAndNumbersFromBeforeKeepTheirNames()
    {
        var rules = new RenumberRules();
        rules.Vendors.Add(VaultPaths.Key("Library/Bearing 6203.SLDPRT"));
        rules.Keep.Add(VaultPaths.Key("Library/Spare.SLDPRT"));
        var plan = RenumberPlan.Plan(
            [
                new RenumberFile(1, "Library/91251A463_Socket Head Screw.SLDPRT"),
                new RenumberFile(2, "Library/Bearing 6203.SLDPRT"),
                new RenumberFile(3, "Library/Washer.SLDPRT", vendor: true),
                new RenumberFile(4, "Ground/00000011-001.SLDPRT"),
                new RenumberFile(5, "Ground/00000004-010-6.SLDPRT"),
                new RenumberFile(6, "Library/Spare.SLDPRT"),
                new RenumberFile(7, "Library/Bracket.SLDPRT"),
            ],
            rules,
            22);

        Assert.Equal(["Library/00000022-001.SLDPRT"], plan.Renames.Select(r => r.NewPath));
        Assert.Equal(
            [(1L, "a vendor's part"), (2, "a vendor's part"), (3, "a vendor's part"), (4, "named by a part number already"), (5, "named by a part number already"), (6, "kept, as the review says")],
            plan.Kept.Select(k => (k.File.Id, k.Why)).OrderBy(k => k.Item1));
    }

    [Fact]
    public void DrawingsAndExportsTakeTheirModelsNumbers()
    {
        var plan = RenumberPlan.Plan(
            [
                new RenumberFile(1, "Fins/Fin.SLDPRT"),
                new RenumberFile(2, "Fins/Fin Can.SLDASM"),
                new RenumberFile(3, "Fins/Fin - machining.SLDDRW", uses: [1]),
                new RenumberFile(4, "Fins/Fin Can - assembly.SLDDRW"), // what it shows isn't recorded: by its name, the longest
                new RenumberFile(5, "Fins/Fin.PDF"),
                new RenumberFile(6, "Fins/Fin.STEP"),
                new RenumberFile(7, "Fins/Finish.PDF"), // not Fin's
                new RenumberFile(8, "Other/Fin.PDF"), // not in Fin's folder
            ],
            new RenumberRules(),
            100);

        var names = plan.Renames.ToDictionary(r => r.File.Id, r => r.NewName);
        Assert.Equal("00000100-501.SLDASM", names[2]);
        Assert.Equal("00000101-001.SLDPRT", names[1]);
        Assert.Equal("00000101-001 - machining.SLDDRW", names[3]);
        Assert.Equal("00000100-501 - assembly.SLDDRW", names[4]);
        Assert.Equal("00000101-001.PDF", names[5]);
        Assert.Equal("00000101-001.STEP", names[6]);
        Assert.False(names.ContainsKey(7) || names.ContainsKey(8));
        Assert.Equal("drawing of Fins/Fin.SLDPRT", plan.Renames.Single(r => r.File.Id == 3).Role);
    }

    [Fact]
    public void ADrawingNotNamedAfterWhatItShowsIsInTheWay()
    {
        var plan = RenumberPlan.Plan([new RenumberFile(1, "Fins/Fin.SLDPRT"), new RenumberFile(2, "Fins/Sheet 1.SLDDRW", uses: [1])], new RenumberRules(), 1);
        Assert.Contains("Fins/Sheet 1.SLDDRW shows a part being numbered", Assert.Single(plan.Problems));
    }

    [Fact]
    public void FoldersSayWhichKindsTheirFilesTake()
    {
        var rules = RenumberCsv.ReadRules(kinds: new StringReader("folder,part kind,assembly kind\nStructures,002,502\nStructures/Rails,003,\n"));
        rules.Titles[VaultPaths.Key("Structures/Bulkhead.SLDPRT")] = "Bulkhead, forward";
        var plan = RenumberPlan.Plan(
            [
                new RenumberFile(1, "Structures/Bulkhead.SLDPRT"),
                new RenumberFile(2, "Structures/Frame.SLDASM"),
                new RenumberFile(3, "Structures/Rails/Rail.SLDPRT"),
                new RenumberFile(4, "Avionics/Sled.SLDPRT"),
            ],
            rules,
            1);

        var kinds = plan.Renames.ToDictionary(r => r.File.Id, r => r.Kind);
        Assert.Equal(("002", "502", "003", "001"), (kinds[1], kinds[2], kinds[3], kinds[4]));
        Assert.Equal("Bulkhead, forward", plan.Renames.Single(r => r.File.Id == 1).Title);
        // A kind left empty isn't one: the review fixes it first.
        Assert.Empty(plan.Problems);
        var empty = RenumberPlan.Plan([new RenumberFile(5, "Structures/Rails/Frame.SLDASM")], rules, 1);
        Assert.Contains("isn't a kind of part number", Assert.Single(empty.Problems));
    }

    [Fact]
    public void TwoFilesNeverEndUpWithOneName()
    {
        // A number from before, at the start of where the plan's numbers go: the run hands them out after it.
        var plan = RenumberPlan.Plan([new RenumberFile(1, "Fins/00000022-001.SLDPRT"), new RenumberFile(2, "Fins/Fin.SLDPRT")], new RenumberRules(), 22);
        Assert.Contains("Two files would be named fins/00000022-001.sldprt", plan.Problems);
    }

    [Fact]
    public void ThePlanIsTheSameWhateverOrderTheVaultIsListedIn()
    {
        RenumberFile[] files =
        [
            new RenumberFile(1, "B/Two.SLDPRT"), new RenumberFile(2, "A/One.SLDASM"), new RenumberFile(3, "A/One.SLDPRT"),
            new RenumberFile(4, "B/Two.SLDDRW", uses: [1]),
        ];
        var forward = RenumberPlan.Plan(files, new RenumberRules(), 7);
        var backward = RenumberPlan.Plan(files.AsEnumerable().Reverse(), new RenumberRules(), 7);
        Assert.Equal(forward.Renames.Select(r => (r.File.Id, r.NewName)).OrderBy(r => r.Id), backward.Renames.Select(r => (r.File.Id, r.NewName)).OrderBy(r => r.Id));
    }

    [Fact]
    public void ThePlanAndTheReviewAreCsvFilesForExcel()
    {
        var rules = RenumberCsv.ReadRules(
            vendors: new StringReader("﻿path\r\n\"Library/Bearing, 6203.SLDPRT\"\r\n"),
            titles: new StringReader("path,title\nFins/Fin.SLDPRT,\"Fin, left \"\"port\"\" side\"\n"));
        var plan = RenumberPlan.Plan(
            [new RenumberFile(1, "Fins/Fin.SLDPRT"), new RenumberFile(2, "Library/Bearing, 6203.SLDPRT")],
            rules,
            5);
        var written = new StringWriter();
        RenumberCsv.WritePlan(written, plan);

        var rows = RenumberCsv.Rows(new StringReader(written.ToString())).ToList();
        Assert.Equal(["1", "Fins/Fin.SLDPRT", "00000005-001.SLDPRT", "00000005-001", "001", "Fin, left \"port\" side", "part"], rows[0]);
        Assert.Equal(["2", "Library/Bearing, 6203.SLDPRT", "Bearing, 6203.SLDPRT", "", "", "Bearing, 6203", "a vendor's part"], rows[1]);
        Assert.Contains("1 parts and assemblies take numbers 00000005 to 00000005", plan.Report());
    }
}
