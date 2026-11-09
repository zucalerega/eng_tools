using System.Runtime.Versioning;
using System.Text;
using System.Text.Json.Nodes;

namespace Vault.Client.Tests;

/// <summary>Two people's workspaces against a real server: the everyday check-out/check-in loop.</summary>
[Collection("server")]
public sealed class WorkspaceTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-workspaces-" + Guid.NewGuid().ToString("N"));
    private readonly string _folder = "Test-" + Guid.NewGuid().ToString("N").Substring(0, 8);
    private readonly List<Workspace> _workspaces = new List<Workspace>();

    public WorkspaceTests(ServerFixture server) => _server = server;

    public void Dispose()
    {
        _workspaces.ForEach(w => w.Dispose());
        TempFolders.Delete(_temp);
    }

    [Fact]
    public async Task AddGetCheckOutCheckInRoundTrip()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceFin = Write(alice, "Fins/Fin.SLDPRT", "fin v1");

        Assert.Equal(FileState.New, Assert.Single(await alice.StatusAsync([aliceFin])).State);
        var added = await alice.CheckinAsync([aliceFin], "first fin");
        Assert.Equal("created", Assert.Single(added.Files).Status);
        Assert.True(IsReadOnly(aliceFin));

        await bob.GetLatestAsync([Folder(bob)]);
        var bobFin = Local(bob, "Fins/Fin.SLDPRT");
        Assert.Equal("fin v1", File.ReadAllText(bobFin));
        Assert.True(IsReadOnly(bobFin));

        await bob.CheckoutAsync([bobFin]);
        Assert.False(IsReadOnly(bobFin));
        var seenByAlice = Assert.Single(await alice.StatusAsync([aliceFin]));
        Assert.Equal(("BOB-PC", false), (seenByAlice.Lock?.Host, seenByAlice.CheckedOutByMe));

        File.WriteAllText(bobFin, "fin v2");
        Assert.Equal(FileState.Modified, Assert.Single(await bob.StatusAsync([bobFin])).State);
        var updated = await bob.CheckinAsync([bobFin], "thicker root");
        Assert.Equal(("updated", 2), (updated.Files[0].Status, updated.Files[0].File.Version));
        Assert.True(IsReadOnly(bobFin));
        Assert.Equal(FileState.UpToDate, Assert.Single(await bob.StatusAsync([bobFin])).State);

        Assert.Equal(FileState.Outdated, Assert.Single(await alice.StatusAsync([aliceFin])).State);
        await alice.GetLatestAsync([aliceFin]);
        Assert.Equal("fin v2", File.ReadAllText(aliceFin));

        var history = await alice.HistoryAsync(aliceFin);
        Assert.Equal(["thicker root", "first fin"], history.Versions.Select(v => v.Comment));
    }

    [Fact]
    public async Task OnlyOnePersonCanCheckOutAFile()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var nosecone = Write(alice, "Nosecone.SLDPRT", "v1");
        await alice.CheckinAsync([nosecone], "add nosecone");
        await bob.GetLatestAsync([Folder(bob)]);
        await alice.CheckoutAsync([nosecone]);

        var taken = await Assert.ThrowsAsync<VaultApiException>(() => bob.CheckoutAsync([Local(bob, "Nosecone.SLDPRT")]));
        Assert.Equal("checked_out", taken.Code);
        Assert.Contains("ALICE-PC", taken.Message, StringComparison.Ordinal);

        var notYours = await Assert.ThrowsAsync<WorkspaceException>(() => bob.CheckinAsync([Local(bob, "Nosecone.SLDPRT")], "sneaky"));
        Assert.Contains("checked out by Alice on ALICE-PC", notYours.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task GetNeverOverwritesLocalChangesWithoutForce()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceRing = Write(alice, "Ring.SLDPRT", "v1");
        await alice.CheckinAsync([aliceRing], "add ring");
        await bob.GetLatestAsync([Folder(bob)]);

        var bobRing = Local(bob, "Ring.SLDPRT");
        MakeWritable(bobRing);
        File.WriteAllText(bobRing, "bob's edit without checking out");
        await alice.CheckoutAsync([aliceRing]);
        File.WriteAllText(aliceRing, "v2");
        await alice.CheckinAsync([aliceRing], "alice's change");

        Assert.Equal(FileState.Conflict, Assert.Single(await bob.StatusAsync([bobRing])).State);
        var skipped = await bob.GetLatestAsync([bobRing]);
        Assert.Single(skipped.Skipped);
        Assert.Equal("bob's edit without checking out", File.ReadAllText(bobRing));

        var forced = await bob.GetLatestAsync([bobRing], force: true);
        Assert.Equal("v2", File.ReadAllText(bobRing));
        Assert.Equal("bob's edit without checking out", File.ReadAllText(Assert.Single(forced.BackedUp)));
    }

    [Fact]
    public async Task KeepingMineChecksItOutToCheckInOnTopOfTheirs()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceTank = Write(alice, "Tank.SLDPRT", "v1");
        await alice.CheckinAsync([aliceTank], "add tank");
        await bob.GetLatestAsync([Folder(bob)]);
        var bobTank = Local(bob, "Tank.SLDPRT");
        MakeWritable(bobTank);
        File.WriteAllText(bobTank, "bob's thicker wall");
        await alice.CheckoutAsync([aliceTank]);
        File.WriteAllText(aliceTank, "alice's v2");
        await alice.CheckinAsync([aliceTank], "alice's change");
        Assert.Equal(FileState.Conflict, Assert.Single(await bob.StatusAsync([bobTank])).State);

        var kept = Assert.Single(await bob.KeepMineAsync([bobTank]));
        Assert.Equal((FileState.Modified, true), (kept.State, kept.CheckedOutByMe));
        Assert.Equal("bob's thicker wall", File.ReadAllText(bobTank));
        Assert.False(IsReadOnly(bobTank));
        var status = Assert.Single(await bob.StatusAsync([bobTank]));
        Assert.Equal((FileState.Modified, true, 2), (status.State, status.CheckedOutByMe, status.LocalVersion));

        var checkedIn = await bob.CheckinAsync([bobTank], "bob's wall, on top of alice's");
        Assert.Equal(3, Assert.Single(checkedIn.Files).File.Version);
        await alice.GetLatestAsync([aliceTank]);
        Assert.Equal("bob's thicker wall", File.ReadAllText(aliceTank));
        var history = await alice.HistoryAsync(aliceTank);
        Assert.Equal(["bob's wall, on top of alice's", "alice's change", "add tank"], history.Versions.Select(v => v.Comment));
    }

    [Fact]
    public async Task UsingTheVaultsVersionReplacesOnlyWhatsInConflict()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceRing = Write(alice, "Ring.SLDPRT", "ring v1");
        var aliceFin = Write(alice, "Fin.SLDPRT", "fin v1");
        await alice.CheckinAsync([aliceRing, aliceFin], "add ring and fin");
        await bob.GetLatestAsync([Folder(bob)]);
        var bobRing = Local(bob, "Ring.SLDPRT");
        var bobFin = Local(bob, "Fin.SLDPRT");
        MakeWritable(bobRing);
        File.WriteAllText(bobRing, "bob's ring");
        await bob.CheckoutAsync([bobFin]);
        File.WriteAllText(bobFin, "bob's fin, checked out");
        await alice.CheckoutAsync([aliceRing]);
        File.WriteAllText(aliceRing, "alice's ring");
        await alice.CheckinAsync([aliceRing], "alice's ring");

        // The whole folder: the ring is in conflict; the fin, checked out to Bob with his change, isn't.
        var replaced = await bob.UseVaultVersionAsync([Folder(bob)]);
        Assert.Equal(bobRing, Assert.Single(replaced.Downloaded).LocalPath);
        Assert.Equal("alice's ring", File.ReadAllText(bobRing));
        Assert.True(IsReadOnly(bobRing));
        Assert.Equal("bob's ring", File.ReadAllText(Assert.Single(replaced.BackedUp)));
        Assert.Equal(FileState.UpToDate, Assert.Single(await bob.StatusAsync([bobRing])).State);
        Assert.Equal("bob's fin, checked out", File.ReadAllText(bobFin));
    }

    [Fact]
    public async Task OnlyFilesInConflictAreSettled()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceNozzle = Write(alice, "Nozzle.SLDPRT", "v1");
        await alice.CheckinAsync([aliceNozzle], "add nozzle");
        await bob.GetLatestAsync([Folder(bob)]);
        var bobNozzle = Local(bob, "Nozzle.SLDPRT");

        var upToDate = await Assert.ThrowsAsync<WorkspaceException>(() => bob.KeepMineAsync([bobNozzle]));
        Assert.Contains("Nozzle.SLDPRT isn't in conflict: it's up to date", upToDate.Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<WorkspaceException>(() => bob.UseVaultVersionAsync([bobNozzle]));

        // In conflict, but Alice kept it checked out: keeping Bob's copy needs the check-out, so nothing changes.
        MakeWritable(bobNozzle);
        File.WriteAllText(bobNozzle, "bob's nozzle");
        await alice.CheckoutAsync([aliceNozzle]);
        File.WriteAllText(aliceNozzle, "alice's nozzle");
        await alice.CheckinAsync([aliceNozzle], "alice's nozzle", keepCheckedOut: true);
        var taken = await Assert.ThrowsAsync<VaultApiException>(() => bob.KeepMineAsync([bobNozzle]));
        Assert.Equal("checked_out", taken.Code);
        Assert.Equal(FileState.Conflict, Assert.Single(await bob.StatusAsync([bobNozzle])).State);
        Assert.Equal("bob's nozzle", File.ReadAllText(bobNozzle));
    }

    [Fact]
    public async Task CopiesThatDidntComeFromTheVaultAreSettledToo()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        Write(alice, "Mount.SLDASM", "the vault's mount");
        Write(alice, "Barrel.SLDPRT", "the barrel");
        await alice.CheckinAsync([Folder(alice)], "add mount and barrel");

        // Bob's copies came another way (an old workspace's, say): one as the vault has it, one with his later work.
        var bobMount = Write(bob, "Mount.SLDASM", "bob's later mount");
        var bobBarrel = Write(bob, "Barrel.SLDPRT", "the barrel");
        var statuses = await bob.StatusAsync([Folder(bob)]);
        Assert.Equal(FileState.UpToDate, statuses.Single(s => s.LocalPath == bobBarrel).State);
        Assert.Equal(FileState.Conflict, statuses.Single(s => s.LocalPath == bobMount).State);

        await bob.KeepMineAsync([bobMount]);
        var checkedIn = Assert.Single((await bob.CheckinAsync([bobMount], "my mount, from before")).Files);
        Assert.Equal(("updated", 2), (checkedIn.Status, checkedIn.File.Version));
        Assert.Equal(FileState.UpToDate, Assert.Single(await bob.StatusAsync([bobMount])).State);
    }

    [Fact]
    public async Task UndoCheckoutBacksUpAndRestores()
    {
        var alice = await WorkspaceAsync("alice");
        var bulkhead = Write(alice, "Bulkhead.SLDPRT", "v1");
        await alice.CheckinAsync([bulkhead], "add bulkhead");
        await alice.CheckoutAsync([bulkhead]);
        File.WriteAllText(bulkhead, "experiment that didn't work");

        var undone = await alice.UndoCheckoutAsync([bulkhead]);
        Assert.Equal("v1", File.ReadAllText(bulkhead));
        Assert.True(IsReadOnly(bulkhead));
        Assert.Equal("experiment that didn't work", File.ReadAllText(Assert.Single(undone.BackedUp)));
        var status = Assert.Single(await alice.StatusAsync([bulkhead]));
        Assert.Equal((FileState.UpToDate, null), (status.State, status.Lock));
    }

    [Fact]
    public async Task UndoKeepsTheCheckoutWhenTheFileCannotBeRestored()
    {
        var alice = await WorkspaceAsync("alice");
        var valve = Write(alice, "Valve.SLDPRT", "v1");
        await alice.CheckinAsync([valve], "add valve");
        await alice.CheckoutAsync([valve]);
        File.WriteAllText(valve, "bigger orifice");

        using (HoldOpen(valve))
        {
            await Assert.ThrowsAsync<WorkspaceException>(() => alice.UndoCheckoutAsync([valve]));
        }
        // Still checked out, changes and all, so closing the file and undoing again works.
        var kept = Assert.Single(await alice.StatusAsync([valve]));
        Assert.Equal((FileState.Modified, true), (kept.State, kept.CheckedOutByMe));
        Assert.Equal("bigger orifice", File.ReadAllText(valve));

        var undone = await alice.UndoCheckoutAsync([valve]);
        Assert.Equal("v1", File.ReadAllText(valve));
        Assert.True(IsReadOnly(valve));
        Assert.Equal("bigger orifice", File.ReadAllText(Assert.Single(undone.BackedUp)));
        Assert.Null(Assert.Single(await alice.StatusAsync([valve])).Lock);
    }

    [Fact]
    public async Task LeadsCanTakeOverSomeonesCheckout()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var chief = await WorkspaceAsync("chief"); // the server's admin
        var pump = Write(alice, "Pump.SLDPRT", "v1");
        await alice.CheckinAsync([pump], "add pump");
        await alice.CheckoutAsync([pump]);
        File.WriteAllText(pump, "alice's impeller");

        await bob.GetLatestAsync([Folder(bob)]);
        var bobPump = Local(bob, "Pump.SLDPRT");
        Assert.False(bob.CanTakeOver(Assert.Single(await bob.StatusAsync([bobPump])))); // an editor
        await Assert.ThrowsAsync<VaultApiException>(() => bob.CheckoutAsync([bobPump], force: true));

        await chief.GetLatestAsync([Folder(chief)]);
        var chiefPump = Local(chief, "Pump.SLDPRT");
        Assert.True(chief.CanTakeOver(Assert.Single(await chief.StatusAsync([chiefPump]))));
        await chief.CheckoutAsync([chiefPump], force: true);
        Assert.False(IsReadOnly(chiefPump));

        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckinAsync([pump], "new impeller"));
        Assert.Contains("on CHIEF-PC: chief took it over from you", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("alice's impeller", File.ReadAllText(pump)); // still here
    }

    [Fact]
    public async Task CheckingInAfterYourCheckoutWasReleasedSaysWhoReleasedIt()
    {
        var alice = await WorkspaceAsync("alice");
        var chief = await WorkspaceAsync("chief");
        var fin = Write(alice, "Fin.SLDPRT", "v1");
        await alice.CheckinAsync([fin], "add fin");
        await alice.CheckoutAsync([fin]);
        File.WriteAllText(fin, "swept fin");
        await chief.Api.UndoCheckoutAsync([$"{_folder}/Fin.SLDPRT"]); // a lead's "break lock"

        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckinAsync([fin], "swept"));
        Assert.Contains("chief released your check-out", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("check it out again", refused.Message, StringComparison.Ordinal);

        await alice.CheckoutAsync([fin]);
        var checkedIn = await alice.CheckinAsync([fin], "swept");
        Assert.Equal(2, Assert.Single(checkedIn.Files).File.Version);
    }

    [Fact]
    public async Task UnchangedCheckinJustReleasesTheLock()
    {
        var alice = await WorkspaceAsync("alice");
        var motor = Write(alice, "Motor.SLDASM", "asm");
        await alice.CheckinAsync([motor], "add motor");
        await alice.CheckoutAsync([motor]);
        var result = await alice.CheckinAsync([motor], "no changes");
        Assert.Equal(("unchanged", 1), (result.Files[0].Status, result.Files[0].File.Version));
        Assert.Null(result.CheckinId);
        Assert.True(IsReadOnly(motor));
    }

    [Fact]
    public async Task UpdatingGetsNewVersionsOfWhatsHereAndNothingElse()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var can = Write(alice, "Fins/Fin Can.SLDASM", "can v1");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        var uses = new Dictionary<string, string[]> { [can] = [fin], [fin] = [] };
        await alice.CheckinAsync([can], "fin can", referencesOf: path => uses[path]);
        await alice.CheckinAsync([Write(alice, "Motor/Grain.SLDPRT", "grain")], "grain");
        await bob.GetLatestAsync([Local(bob, "Fins/Fin Can.SLDASM")]); // opened it: it brings its fin

        // Alice adds a tab to the fin can, and changes the grain, which Bob never got.
        var tab = Write(alice, "Fins/Tab.SLDPRT", "tab");
        uses[can] = [fin, tab];
        uses[tab] = [];
        await alice.CheckoutAsync([can]);
        File.WriteAllText(can, "can v2");
        await alice.CheckinAsync([can], "tabs", referencesOf: path => uses[path]);
        var grain = Local(alice, "Motor/Grain.SLDPRT");
        await alice.CheckoutAsync([grain]);
        File.WriteAllText(grain, "grain v2");
        await alice.CheckinAsync([grain], "longer grain");

        var everything = await bob.SizeOfGetAsync([Folder(bob)]);
        // New: the tab (3 bytes) and the grain (8); newer: the can (6).
        Assert.Equal((2, 1, 17L), (everything.NewFiles, everything.UpdatedFiles, everything.Bytes));

        var updated = await bob.UpdateAsync([Folder(bob)]);
        Assert.Equal(["Fin Can.SLDASM", "Tab.SLDPRT"], updated.Downloaded.Select(Name).OrderBy(n => n, StringComparer.Ordinal));
        Assert.Equal("can v2", File.ReadAllText(Local(bob, "Fins/Fin Can.SLDASM")));
        Assert.False(File.Exists(Local(bob, "Motor/Grain.SLDPRT"))); // still only in the vault
        Assert.Equal(FileState.Missing, Assert.Single(await bob.StatusAsync([Local(bob, "Motor")])).State);
    }

    [Fact]
    public async Task DeletedFilesLeaveTheWorkspaceOnGet()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var old = Write(alice, "Old Bracket.STEP", "bracket");
        await alice.CheckinAsync([old], "add bracket");
        await bob.GetLatestAsync([Folder(bob)]);

        await alice.Api.DeleteAsync([$"{_folder}/Old Bracket.STEP"]);
        var bobOld = Local(bob, "Old Bracket.STEP");
        Assert.Equal(FileState.DeletedInVault, Assert.Single(await bob.StatusAsync([bobOld])).State);
        var result = await bob.GetLatestAsync([Folder(bob)]);
        Assert.Single(result.Removed);
        Assert.False(File.Exists(bobOld));
    }

    [Fact]
    public async Task CheckingInWhatUsesAFileDeletedInTheVaultSaysHowToGoOn()
    {
        // Someone deleted a sub-assembly that an assembly here still uses: the vault would have a hole in the assembly.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync([Write(alice, "Legs/Leg Assembly.SLDASM", "legs")], "the legs");
        await bob.GetLatestAsync([Folder(bob)]);
        await alice.Api.DeleteAsync([$"{_folder}/Legs/Leg Assembly.SLDASM"]);
        var legs = Local(bob, "Legs/Leg Assembly.SLDASM");
        var vehicle = Write(bob, "Vehicle.SLDASM", "vehicle");

        var uses = await Assert.ThrowsAsync<WorkspaceException>(
            () => bob.CheckinAsync([vehicle], "vehicle", referencesOf: path => path == vehicle ? [legs] : []));
        Assert.Equal(
            $"{_folder}/Vehicle.SLDASM uses {_folder}/Legs/Leg Assembly.SLDASM, which was deleted from the vault since you got it. "
            + "Restore it from its folder's trash in the web app, or take it out of Vehicle.SLDASM, then check in again.",
            uses.Message);
        var itself = await Assert.ThrowsAsync<WorkspaceException>(() => bob.CheckinAsync([legs], "legs"));
        Assert.Equal(
            $"{_folder}/Legs/Leg Assembly.SLDASM was deleted from the vault since you got it. "
            + "Restore it from its folder's trash in the web app to check it in.",
            itself.Message);
    }

    [Fact]
    public async Task APartsLinkToAFileDeletedInTheVaultDoesntKeepItOut()
    {
        // A part edited in the context of an assembly links to it: SolidWorks names that assembly among the part's
        // references. Once someone deletes the assembly, anyway, the part still goes in without the link, and so does
        // every assembly that takes the part along; an assembly's own deleted component still keeps it out (above).
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var old = Write(alice, "Old/Old Assembly.SLDASM", "old");
        var bracket = Write(alice, "Bracket.SLDPRT", "bracket");
        var aliceUses = new Dictionary<string, string[]> { [old] = [bracket], [bracket] = [old] };
        await alice.CheckinAsync([old], "edited in context", referencesOf: path => aliceUses[path]);
        await bob.GetLatestAsync([Folder(bob)]);
        await alice.Api.DeleteAsync([$"{_folder}/Old/Old Assembly.SLDASM"], force: true); // the bracket uses it
        var bobBracket = Local(bob, "Bracket.SLDPRT");
        var bobUses = new Dictionary<string, string[]> { [bobBracket] = [Local(bob, "Old/Old Assembly.SLDASM")] };
        IEnumerable<string> UsedByBob(string path) => bobUses.TryGetValue(path, out var used) ? used : [];

        await bob.CheckoutAsync([bobBracket]);
        File.WriteAllText(bobBracket, "bracket v2");
        var result = await bob.CheckinAsync([bobBracket], "thicker", referencesOf: UsedByBob);
        Assert.Equal(("updated", 2), (result.Files[0].Status, result.Files[0].File.Version));
        var link = Assert.Single(result.LeftOut);
        Assert.Equal(($"{_folder}/Bracket.SLDPRT", $"{_folder}/Old/Old Assembly.SLDASM"), (link.File, link.Deleted));
        Assert.Empty((await bob.HistoryAsync(bobBracket)).Versions[0].References);

        var mount = Write(bob, "Mount.SLDASM", "mount");
        bobUses[mount] = [bobBracket];
        await bob.CheckoutAsync([bobBracket]);
        File.WriteAllText(bobBracket, "bracket v3");
        result = await bob.CheckinAsync([mount], "mount", referencesOf: UsedByBob);
        Assert.Equal(
            new[] { ("Bracket.SLDPRT", "updated"), ("Mount.SLDASM", "created") },
            result.Files.Select(f => (f.File.Name, f.Status)).OrderBy(f => f.Name, StringComparer.Ordinal).ToArray());
        Assert.Single(result.LeftOut);
        var pinned = Assert.Single((await bob.HistoryAsync(mount)).Versions[0].References);
        Assert.Equal(($"{_folder}/Bracket.SLDPRT", 3), (pinned.Path, pinned.Version));
    }

    [Fact]
    public async Task IdenticalCopiesAreRecognized()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync([Write(alice, "Bolt.STEP", "bolt")], "add bolt");
        Write(bob, "Bolt.STEP", "bolt"); // e.g. copied over from the old Kenesto folder
        var status = Assert.Single(await bob.StatusAsync([Local(bob, "Bolt.STEP")]));
        Assert.Equal((FileState.UpToDate, 1), (status.State, status.LocalVersion));
    }

    [Fact]
    public async Task AnAssemblyBringsItsNewPartsAndPinsWhatItUses()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceBolt = Write(alice, "Library/Bolt.STEP", "bolt v1");
        await alice.CheckinAsync([aliceBolt], "add bolt");
        // Bob lengthens the bolt; Alice's assembly is still built against v1.
        await bob.GetLatestAsync([Folder(bob)]);
        var bobBolt = Local(bob, "Library/Bolt.STEP");
        await bob.CheckoutAsync([bobBolt]);
        File.WriteAllText(bobBolt, "bolt v2");
        await bob.CheckinAsync([bobBolt], "longer bolt");

        var can = Write(alice, "Fins/Fin Can.SLDASM", "assembly");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        var uses = new Dictionary<string, string[]> { [can] = [fin, aliceBolt], [fin] = [] };
        var result = await alice.CheckinAsync([can], "fin can", referencesOf: path => uses[path]);

        Assert.Equal(["Fin Can.SLDASM", "Fin.SLDPRT"], result.Files.Select(f => f.File.Name).OrderBy(n => n, StringComparer.Ordinal));
        var history = await alice.HistoryAsync(can);
        var pinned = history.Versions[0].References.Select(r => (r.Path, r.Version)).OrderBy(r => r.Path, StringComparer.Ordinal);
        Assert.Equal(new[] { ($"{_folder}/Fins/Fin.SLDPRT", 1), ($"{_folder}/Library/Bolt.STEP", 1) }, pinned.ToArray());
    }

    [Fact]
    public async Task ChangedPartsCheckedOutToYouJoinTheirAssembly()
    {
        var alice = await WorkspaceAsync("alice");
        var tank = Write(alice, "Tank.SLDASM", "asm v1");
        var wall = Write(alice, "Tank Wall.SLDPRT", "wall v1");
        var uses = (string path) => path == tank ? new[] { wall } : Array.Empty<string>();
        await alice.CheckinAsync([tank], "add tank", referencesOf: uses);
        await alice.CheckoutAsync([tank, wall]);
        File.WriteAllText(tank, "asm v2");
        File.WriteAllText(wall, "wall v2");

        var result = await alice.CheckinAsync([tank], "thicker wall", referencesOf: uses);
        Assert.Equal([2, 2], result.Files.Select(f => f.File.Version));
    }

    [Fact]
    public async Task BrowsingShowsFoldersFilesAndHowTheyFitTogether()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        var can = Write(alice, "Fins/Fin Can.SLDASM", "can");
        var drawing = Write(alice, "Fins/Fin.SLDDRW", "drawing");
        var rocket = Write(alice, "Rocket.SLDASM", "rocket");
        var uses = new Dictionary<string, string[]> { [rocket] = [can], [can] = [fin], [drawing] = [fin], [fin] = [] };
        await alice.CheckinAsync([rocket, drawing], "the rocket", referencesOf: path => uses[path]);
        Write(alice, "Fins/Bracket.SLDPRT", "not checked in yet");
        await bob.CheckoutAsync([Local(bob, "Fins/Fin.SLDPRT")]);

        var tree = await alice.BrowseAsync();
        var top = Assert.Single(tree.Root.Folders, f => f.Name == _folder);
        Assert.Equal(["Rocket.SLDASM"], top.Files.Select(Name));
        var fins = Assert.Single(top.Folders);
        Assert.Equal(["Bracket.SLDPRT", "Fin Can.SLDASM", "Fin.SLDDRW", "Fin.SLDPRT"], fins.Files.Select(Name));
        Assert.Equal((FileState.New, 1, 1), (fins.Files[0].State, fins.CheckedOut, top.CheckedOut));
        Assert.Empty(tree.Uses(fins.Files[0])!); // not in the vault

        var assembly = Assert.Single(tree.Uses(top.Files[0])!);
        Assert.Equal(("Fin Can.SLDASM", 1), (Name(assembly.File!), assembly.Version));
        var part = Assert.Single(tree.Uses(assembly.File!)!).File!;
        Assert.Equal(("Fin.SLDPRT", "BOB-PC"), (Name(part), part.Lock?.Host));
        Assert.Equal(["Fin Can.SLDASM", "Fin.SLDDRW"], tree.UsedBy(part).Select(Name));
        Assert.Equal(["Fin.SLDDRW"], tree.Drawings(part).Select(Name));
    }

    [Fact]
    public async Task ANewDrawingOfAPartYoureChangingLeavesThePartOut()
    {
        var alice = await WorkspaceAsync("alice");
        var tank = Write(alice, "Tank.SLDPRT", "tank v1");
        await alice.CheckinAsync([tank], "add tank");
        await alice.CheckoutAsync([tank]);
        File.WriteAllText(tank, "tank v2, not done yet");
        var drawing = Write(alice, "Tank.SLDDRW", "drawing");

        var result = await alice.CheckinAsync(
            [drawing], "new drawing", keepCheckedOut: true, referencesOf: path => path == drawing ? [tank] : [], withChangedReferences: false);
        Assert.Equal(["Tank.SLDDRW"], result.Files.Select(f => f.File.Name));
        var part = Assert.Single(await alice.StatusAsync([tank]));
        Assert.Equal((FileState.Modified, true), (part.State, part.CheckedOutByMe)); // still yours, changes and all
        Assert.Equal(1, Assert.Single((await alice.HistoryAsync(drawing)).Versions[0].References).Version);
    }

    [Fact]
    public async Task NewFilesNeedAFreeName()
    {
        var alice = await WorkspaceAsync("alice");
        await alice.CheckinAsync([Write(alice, "Fins/Fin.SLDPRT", "fin")], "add fin");
        Write(alice, "Fins/Draft.SLDPRT", "not checked in yet");

        await alice.CheckNewFileAsync(Local(alice, "Fins/Bracket.SLDPRT"));
        await alice.CheckNewFileAsync(Local(alice, "Recovery/Harness.SLDPRT")); // a new folder is fine
        var taken = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckNewFileAsync(Local(alice, "fins/FIN.sldprt")));
        Assert.Contains("already in the vault", taken.Message, StringComparison.Ordinal);
        var here = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckNewFileAsync(Local(alice, "Fins/Draft.SLDPRT")));
        Assert.Contains("already here", here.Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckNewFileAsync(Local(alice, "Fins")));
        await Assert.ThrowsAsync<VaultPathException>(() => alice.CheckNewFileAsync(Local(alice, "Fins/Fin: v2.SLDPRT")));
    }

    [Fact]
    public async Task CopiesFollowMovesAndRenamesInTheVault()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var chief = await WorkspaceAsync("chief"); // renaming a folder takes a lead
        await alice.CheckinAsync([Write(alice, "Inbox/Fin.SLDPRT", "fin"), Write(alice, "Docs/Notes.txt", "notes")], "add");
        await bob.GetLatestAsync([Folder(bob)]);

        await chief.Api.MoveAsync([$"{_folder}/Inbox/Fin.SLDPRT"], [], $"{_folder}/Structures");
        await chief.Api.RenameAsync(null, $"{_folder}/Docs", "Documents");
        var held = Local(bob, "Docs/Notes.txt");
        using (HoldOpen(held)) // as SolidWorks holds what it has open: this one can't move yet
        {
            var statuses = await bob.StatusAsync([Folder(bob)]);
            Assert.True(File.Exists(Local(bob, "Structures/Fin.SLDPRT")));
            Assert.True(IsReadOnly(Local(bob, "Structures/Fin.SLDPRT")));
            Assert.True(Directory.Exists(Local(bob, "Inbox"))); // empty now, but still a folder in the vault
            var notes = Assert.Single(statuses, s => s.VaultPath == $"{_folder}/Documents/Notes.txt");
            Assert.Equal((FileState.UpToDate, held), (notes.State, notes.LocalPath)); // still that file, not a new one
            Assert.DoesNotContain(statuses, s => s.State == FileState.New);
        }
        await bob.StatusAsync([Folder(bob)]);
        Assert.Equal("notes", File.ReadAllText(Local(bob, "Documents/Notes.txt")));
        Assert.False(File.Exists(held));
        Assert.False(Directory.Exists(Local(bob, "Docs"))); // renamed in the vault: tidied away once it was empty
    }

    [Fact]
    public async Task TheVaultsFoldersAreHereToSaveNewFilesIn()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync([Write(alice, "Structures/Fins/Fin.SLDPRT", "fin")], "add fin");

        await bob.RefreshAsync();
        Assert.True(Directory.Exists(Local(bob, "Structures/Fins")));
        Assert.False(File.Exists(Local(bob, "Structures/Fins/Fin.SLDPRT"))); // and nothing downloaded into it
    }

    [Fact]
    public async Task WorksWithAServerFromBeforeFilesSaidWhatTheyUse()
    {
        var alice = await WorkspaceAsync("alice");
        var older = new OlderServer();
        var bob = await WorkspaceAsync("bob", older);
        var can = Write(alice, "Fin Can.SLDASM", "can");
        var fin = Write(alice, "Fin.SLDPRT", "fin");
        await alice.CheckinAsync([can], "fin can", referencesOf: path => path == can ? [fin] : []);

        await bob.GetLatestAsync([Local(bob, "Fin Can.SLDASM")]);
        Assert.True(File.Exists(Local(bob, "Fin.SLDPRT"))); // its part came along all the same
        var before = await bob.BrowseAsync();
        Assert.Null(before.Uses(before.Files.Single(f => f.LocalPath == Local(bob, "Fin Can.SLDASM"))));

        older.IsOlder = false; // the server is updated
        await alice.CheckoutAsync([can]); // and something changes
        var after = await bob.BrowseAsync();
        var uses = after.Uses(after.Files.Single(f => f.LocalPath == Local(bob, "Fin Can.SLDASM")))!;
        Assert.Equal(["Fin.SLDPRT"], uses.Select(used => Name(used.File!)));
    }

    [Fact]
    public async Task SaysWhenSomeoneIsWorkingInSolidWorks()
    {
        var working = false;
        var sent = new SentActivity();
        var alice = await WorkspaceAsync("alice", new ActivityHandler(() => working, sent));

        await alice.RefreshAsync(); // SolidWorks behind another window, or nobody at the computer
        var idle = sent.Sent;
        working = true;
        await alice.RefreshAsync();
        var busy = sent.Sent.Skip(idle.Count).ToList();

        Assert.NotEmpty(idle);
        Assert.All(idle, Assert.Null);
        Assert.NotEmpty(busy);
        Assert.All(busy, activity => Assert.Equal("solidworks", activity));
    }

    [Fact]
    public async Task ReferencesOutsideTheWorkspaceAreRejected()
    {
        var alice = await WorkspaceAsync("alice");
        var outside = Path.Combine(_temp, "Desktop", "Bolt.SLDPRT");
        Directory.CreateDirectory(Path.GetDirectoryName(outside)!);
        File.WriteAllText(outside, "bolt");
        var motor = Write(alice, "Motor.SLDASM", "asm");

        var error = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckinAsync([motor], "motor", referencesOf: _ => [outside]));
        Assert.Contains("outside the workspace", error.Message, StringComparison.Ordinal);
        Assert.Equal(FileState.New, Assert.Single(await alice.StatusAsync([motor])).State); // nothing was checked in
    }

    [Fact]
    public async Task MissingReferencesAreRejected()
    {
        var alice = await WorkspaceAsync("alice");
        var sled = Write(alice, "Sled.SLDASM", "asm");
        var gone = Local(alice, "Battery.SLDPRT"); // neither here nor in the vault
        var error = await Assert.ThrowsAsync<WorkspaceException>(() => alice.CheckinAsync([sled], "sled", referencesOf: _ => [gone]));
        Assert.Contains("missing", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AReferenceInConflictStopsTheCheckinAndSaysHowToSettleIt()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var aliceMount = Write(alice, "Mount.SLDASM", "mount v1");
        await alice.CheckinAsync([aliceMount], "add mount");
        await bob.GetLatestAsync([Folder(bob)]);
        var bobMount = Local(bob, "Mount.SLDASM");
        MakeWritable(bobMount);
        File.WriteAllText(bobMount, "bob's mount");
        await alice.CheckoutAsync([aliceMount]);
        File.WriteAllText(aliceMount, "alice's mount");
        await alice.CheckinAsync([aliceMount], "alice's mount");
        var vehicle = Write(bob, "Vehicle.SLDASM", "vehicle");
        Func<string, IEnumerable<string>> uses = path => path == vehicle ? [bobMount] : [];

        var error = await Assert.ThrowsAsync<WorkspaceException>(() => bob.CheckinAsync([vehicle], "vehicle", referencesOf: uses));
        Assert.Contains("Mount.SLDASM, which changed here after someone checked in a newer version", error.Message, StringComparison.Ordinal);
        Assert.Contains("Keep mine (vault resolve --mine)", error.Message, StringComparison.Ordinal);
        Assert.Contains("Use the vault's version (--vault)", error.Message, StringComparison.Ordinal);

        // Kept, the mount goes in with the vehicle, as its next version.
        await bob.KeepMineAsync([bobMount]);
        var result = await bob.CheckinAsync([vehicle], "vehicle", referencesOf: uses);
        var checkedIn = result.Files.ToDictionary(f => Path.GetFileName(f.File.Path), f => (f.Status, f.File.Version));
        Assert.Equal(("created", 1), checkedIn["Vehicle.SLDASM"]);
        Assert.Equal(("updated", 3), checkedIn["Mount.SLDASM"]);
    }

    [Fact]
    public async Task PathsKeptInFilesFromElsewhereMeanTheVaultFilesTheyEndLike()
    {
        // A folder brought over from Kenesto: its files keep the paths their parts had on Kenesto's drive.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var kenesto = $@"K:\Yellow Jacket Space Program\Project CAD\{_folder}\09_Hopper";
        await alice.CheckinAsync(
            [
                Write(alice, "09_Hopper/Assy - Vehicle.SLDASM", "assembly"),
                Write(alice, "09_Hopper/Stringer.SLDPRT", "stringer"),
                Write(alice, "09_Hopper/Structures/Leg.SLDPRT", "leg"),
                Write(alice, "09_Hopper/Tanks/Bracket.SLDPRT", "tank bracket"),
                Write(alice, "09_Hopper/Legs/Bracket.SLDPRT", "leg bracket"),
            ],
            "from Kenesto");
        await bob.RefreshAsync();

        var (inVault, notInVault) = bob.FindUsedFiles(
        [
            $@"{kenesto}\Stringer.SLDPRT",
            $@"{kenesto}\Structures\LEG.sldprt",
            $@"{kenesto}\Legs\Bracket.SLDPRT",
            @"K:\Old stuff\Bracket.SLDPRT", // either bracket, as far as its path says
            $@"{kenesto}\Nozzle.SLDPRT", // never brought over
            Local(bob, "09_Hopper/Stringer.SLDPRT"), // a path here, to the same file
        ]);

        Assert.Equal(
            [Local(bob, "09_Hopper/Stringer.SLDPRT"), Local(bob, "09_Hopper/Structures/Leg.SLDPRT"), Local(bob, "09_Hopper/Legs/Bracket.SLDPRT")],
            inVault);
        Assert.Equal([@"K:\Old stuff\Bracket.SLDPRT", $@"{kenesto}\Nozzle.SLDPRT"], notInVault);

        // Once they're here, SolidWorks is pointed at them by the same paths, or by a name only one vault file has
        // (a part someone put in an assembly from their Downloads folder, that's in the vault too).
        var vaultPaths = (await bob.StatusAsync()).Where(s => s.FileId != null).Select(s => s.VaultPath).ToList();
        Assert.Null(bob.LocalFileFor($@"{kenesto}\Legs\Bracket.SLDPRT", vaultPaths));
        await bob.GetLatestAsync(inVault);
        Assert.Equal("leg bracket", File.ReadAllText(Local(bob, "09_Hopper/Legs/Bracket.SLDPRT")));
        Assert.Equal(Local(bob, "09_Hopper/Legs/Bracket.SLDPRT"), bob.LocalFileFor($@"{kenesto}\Legs\Bracket.SLDPRT", vaultPaths));
        Assert.Equal(Local(bob, "09_Hopper/Structures/Leg.SLDPRT"), bob.LocalFileFor(@"C:\Users\losha\Downloads\leg.SLDPRT", vaultPaths));
        Assert.Null(bob.LocalFileFor($@"{kenesto}\Nozzle.SLDPRT", vaultPaths));
        Assert.Null(bob.LocalFileFor(Local(bob, "Nozzle.SLDPRT"), vaultPaths)); // a path here means itself
    }

    [Fact]
    public async Task AFileRenamedIsFoundByTheNameItHad()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        await alice.CheckinAsync([fin], "add fin");
        Assert.Equal("Fin, left side", Assert.Single(await alice.DescribeAsync([(fin, "Fin, left side", null)])).Title);
        await bob.GetLatestAsync([Folder(bob)]);

        // Renamed in the vault (given its part number, say): bob's copy follows it, with its title.
        await alice.Api.RenameAsync($"{_folder}/Fins/Fin.SLDPRT", null, "Fin left.SLDPRT");
        var status = Assert.Single(await bob.StatusAsync([Folder(bob)]));
        Assert.Equal(("Fin left.SLDPRT", "Fin, left side", "Fin.SLDPRT"), (Name(status), status.Title, string.Join("|", status.FormerNames)));
        Assert.Equal("fin", File.ReadAllText(Local(bob, "Fins/Fin left.SLDPRT")));

        // SolidWorks files saved before the rename still name it as it was: here, and from elsewhere.
        var kenesto = $@"K:\Project CAD\{_folder}\Fins\Fin.SLDPRT";
        var (inVault, notInVault) = bob.FindUsedFiles([Local(bob, "Fins/Fin.SLDPRT"), kenesto]);
        Assert.Equal([Local(bob, "Fins/Fin left.SLDPRT")], inVault);
        Assert.Empty(notInVault);
        var files = await bob.StatusAsync();
        Assert.Equal(Local(bob, "Fins/Fin left.SLDPRT"), bob.LocalFileFor(Local(bob, "Fins/Fin.SLDPRT"), files));
        Assert.Equal(Local(bob, "Fins/Fin left.SLDPRT"), bob.LocalFileFor(kenesto, files));
    }

    [Fact]
    public async Task ARenumberingPlanIsMadeFromAWorkspacesSnapshot()
    {
        var alice = await WorkspaceAsync("alice");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        var drawing = Write(alice, "Fins/Fin.SLDDRW", "drawing");
        await alice.CheckinAsync([fin, drawing], "a fin and its drawing", referencesOf: p => p == drawing ? new[] { fin } : Array.Empty<string>());

        var files = Renumbering.RenumberPlan.FilesOf(await alice.BrowseAsync()).Where(f => f.Path.StartsWith(_folder + "/", StringComparison.Ordinal));
        var plan = Renumbering.RenumberPlan.Plan(files, new Renumbering.RenumberRules(), 500);
        Assert.Equal([$"{_folder}/Fins/00000500-001.SLDPRT", $"{_folder}/Fins/00000500-001.SLDDRW"], plan.Renames.Select(r => r.NewPath));
        Assert.Equal($"drawing of {_folder}/Fins/Fin.SLDPRT", plan.Renames[1].Role); // as the vault knows: what it shows
    }

    [Fact]
    public async Task AWorkspaceKnowsWhileTheVaultIsPaused()
    {
        var chief = await WorkspaceAsync("chief");
        var bob = await WorkspaceAsync("bob");
        await chief.Api.PauseAsync("RENUMBER-PC", "numbering every file");
        try
        {
            await bob.RefreshAsync();
            Assert.Equal((ServerFixture.Chief, "numbering every file"), (bob.Paused?.By.Email, bob.Paused?.Reason));
        }
        finally
        {
            await chief.Api.UnpauseAsync();
        }
        await bob.RefreshAsync();
        Assert.Null(bob.Paused);
    }

    [Fact]
    public async Task NewFilesCheckedInAsVendorsPartsAreMarked()
    {
        var alice = await WorkspaceAsync("alice");
        var bearing = Write(alice, "Bearings/Bearing 6203.SLDPRT", "bearing");
        var nut = Write(alice, "Bearings/Nut.SLDPRT", "nut");
        var result = await alice.CheckinAsync([bearing, nut], "bought parts", vendorParts: [bearing]);
        Assert.Equal((true, false), (Vendor("Bearing 6203.SLDPRT"), Vendor("Nut.SLDPRT")));
        Assert.True(Assert.Single(await alice.StatusAsync([bearing])).Vendor);

        bool Vendor(string name) => result.Files.Single(f => f.File.Name == name).File.Vendor;
    }

    [Fact]
    public async Task OpeningAFileFromElsewhereGetsWhatItUsesAtEveryLevel()
    {
        // An assembly from Kenesto that's here, with its sub-assembly and its own part, but not the sub-assembly's parts:
        // SolidWorks would open it with those missing.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var kept = await FromKenestoAsync(alice);
        await bob.GetLatestAsync([Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"), Local(bob, "09_Hopper/Thrust Structure.SLDASM"), Local(bob, "09_Hopper/Leg.SLDPRT")]);
        var read = new List<string>();

        var (got, notInVault) = await bob.GetUsedFilesAsync(
            Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"),
            path =>
            {
                read.Add(Path.GetFileName(path));
                return kept(path);
            },
            latest: false);

        Assert.Equal(["Gimbal Ring.SLDPRT", "Stringer.SLDPRT"], got.Downloaded.Select(Name).Order());
        Assert.Equal("stringer", File.ReadAllText(Local(bob, "09_Hopper/Gimbal/Stringer.SLDPRT")));
        Assert.Equal([$@"K:\Yellow Jacket Space Program\Project CAD\{_folder}\09_Hopper\Nozzle.SLDPRT"], notInVault);
        // Each file once, and only once it's here.
        Assert.Equal(["Assy - Vehicle.SLDASM", "Gimbal Ring.SLDPRT", "Leg.SLDPRT", "Stringer.SLDPRT", "Thrust Structure.SLDASM"], read.Order());

        // With everything here, nothing comes down, and what isn't in the vault is still said.
        (got, notInVault) = await bob.GetUsedFilesAsync(Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"), kept, latest: false);
        Assert.Empty(got.Downloaded);
        Assert.Single(notInVault);
    }

    [Fact]
    public async Task GettingTheLatestOfAFileFromElsewhereUpdatesWhatItUsesToo()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var kept = await FromKenestoAsync(alice);
        await bob.GetLatestAsync([Folder(bob)]);
        var leg = Local(alice, "09_Hopper/Leg.SLDPRT");
        await alice.CheckoutAsync([leg]);
        File.WriteAllText(leg, "leg v2");
        await alice.CheckinAsync([leg], "a longer leg");
        await bob.RefreshAsync();

        var (got, _) = await bob.GetUsedFilesAsync(Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"), kept, latest: false);
        Assert.Empty(got.Downloaded); // only what isn't here
        (got, _) = await bob.GetUsedFilesAsync(Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"), kept, latest: true);
        Assert.Equal(["Leg.SLDPRT"], got.Downloaded.Select(Name));
        Assert.Equal("leg v2", File.ReadAllText(Local(bob, "09_Hopper/Leg.SLDPRT")));
    }

    [Fact]
    public async Task OpeningAFileGetsTheStepFilesPlacedInItWith3DInterconnect()
    {
        // SolidWorks names a STEP file placed with 3D Interconnect by the document it made of it in its temporary
        // folder, which is never on disk: what it opens is the STEP file. Two in the vault have this one's name; the one
        // beside what uses it is the one it means.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync(
            [
                Write(alice, "09_Hopper/CTV.SLDASM", "assembly"),
                Write(alice, "09_Hopper/Battery Mount/RECO BMS Mount.SLDASM", "sub-assembly"),
                Write(alice, "09_Hopper/Battery Mount/BMS.step", "bms"),
                Write(alice, "01_Vespula/Battery Box/BMS.step", "another bms"),
                Write(alice, "09_Hopper/RCS/65mm Prop.step", "prop"),
            ],
            "from Kenesto");
        var kenesto = $@"K:\Yellow Jacket Space Program\Project CAD\{_folder}\09_Hopper";
        const string temp = @"C:\Users\adity\AppData\Local\Temp\swx19380\IC~~";
        var keeps = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["CTV.SLDASM"] = [$@"{kenesto}\Battery Mount\RECO BMS Mount.SLDASM", $@"{temp}\65mm Prop.step.SLDPRT", $@"{temp}\Board.step.SLDASM"],
            ["RECO BMS Mount.SLDASM"] = [$@"{temp}\BMS.step.SLDASM"],
        };
        await bob.GetLatestAsync([Local(bob, "09_Hopper/CTV.SLDASM")]);

        var (got, notInVault) = await bob.GetUsedFilesAsync(
            Local(bob, "09_Hopper/CTV.SLDASM"), path => keeps.TryGetValue(Path.GetFileName(path), out var paths) ? paths : [], latest: false);

        Assert.Equal(
            [$"{_folder}/09_Hopper/Battery Mount/BMS.step", $"{_folder}/09_Hopper/Battery Mount/RECO BMS Mount.SLDASM", $"{_folder}/09_Hopper/RCS/65mm Prop.step"],
            got.Downloaded.Select(s => s.VaultPath).Order());
        Assert.Equal("bms", File.ReadAllText(Local(bob, "09_Hopper/Battery Mount/BMS.step")));
        Assert.False(File.Exists(Local(bob, "01_Vespula/Battery Box/BMS.step")));
        // One whose STEP file isn't in the vault is still said, by the STEP file's name.
        Assert.Equal([$@"{temp}\Board.step.SLDASM"], notInVault);
        Assert.Equal("Board.step", Workspace.UsedFileName(notInVault[0]));
        Assert.Equal("Nozzle.SLDPRT", Workspace.UsedFileName($@"{kenesto}\Nozzle.SLDPRT"));
    }

    [Fact]
    public async Task A3DInterconnectFileIsOnlyTakenForOneItCanOnlyMean()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync(
            [
                Write(alice, "09_Hopper/CTV.SLDASM", "assembly"),
                Write(alice, "09_Hopper/Tanks/Bolt.step", "a bolt"),
                Write(alice, "09_Hopper/Legs/Bolt.step", "another bolt"),
                Write(alice, "09_Hopper/Battery Mount/J9.step.SLDASM", "J9, saved as a SolidWorks file"),
                Write(alice, "09_Hopper/Battery Mount/J9.step", "J9"),
            ],
            "from Kenesto");
        await bob.RefreshAsync();
        const string temp = @"C:\Users\adity\AppData\Local\Temp\swx19380\IC~~";

        var (inVault, notInVault) = bob.FindUsedFiles(
            [
                $@"{temp}\Bolt.step.SLDPRT", // either bolt: both are as near the assembly
                $@"{temp}\J9.step.SLDASM", // a file of that name is in the vault, so it's that one, as for any name
                @"C:\Users\adity\Documents\Bolt.step.SLDPRT", // not 3D Interconnect's folder, so a name like any other
            ],
            usedBy: Local(bob, "09_Hopper/CTV.SLDASM"));

        Assert.Equal([Local(bob, "09_Hopper/Battery Mount/J9.step.SLDASM")], inVault);
        Assert.Equal([$@"{temp}\Bolt.step.SLDPRT", @"C:\Users\adity\Documents\Bolt.step.SLDPRT"], notInVault);
    }

    [Fact]
    public async Task PathsHereToFilesTheVaultNoLongerHasMeanTheirCopiesElsewhere()
    {
        // An assembly saved before 09_Hopper was uploaded again as Hopper keeps the old copies' paths here, where
        // SolidWorks finds nothing now that they're deleted.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await UploadedAgainAsync(alice, "Fuel");
        await alice.CheckinAsync(
            [Write(alice, "Hopper/Structures/Payload Interface.SLDPRT", "interface"), Write(alice, "Elytra/Structures/Payload Interface.SLDPRT", "another")],
            "two of a name");
        var mine = Write(bob, "09_Hopper/Tanks/Fuel Baffle.SLDPRT", "bob's, not checked in yet");
        await bob.RefreshAsync();

        var (inVault, notInVault) = bob.FindUsedFiles(
        [
            Local(bob, "09_Hopper/Tanks/Fuel Tank.SLDASM"), // its copy is in a folder of the same name
            Local(bob, "09_Hopper/Hopper Payload.SLDPRT"), // its copy has only its name in common
            Local(bob, "09_Hopper/Structures/Payload Interface.SLDPRT"), // two files end like it
            mine, // here, so it's this one, though Hopper has one that ends like it
        ]);

        Assert.Equal([Local(bob, "Hopper/Tanks/Fuel Tank.SLDASM"), mine], inVault);
        Assert.Equal([Local(bob, "09_Hopper/Hopper Payload.SLDPRT"), Local(bob, "09_Hopper/Structures/Payload Interface.SLDPRT")], notInVault);

        // Once its copy is here, SolidWorks, finding nothing at the old path, is pointed at it.
        var vaultPaths = (await bob.StatusAsync()).Where(s => s.FileId != null).Select(s => s.VaultPath).ToList();
        Assert.Null(bob.LocalFileFor(Local(bob, "09_Hopper/Tanks/Fuel Tank.SLDASM"), vaultPaths));
        await bob.GetLatestAsync([Local(bob, "Hopper/Tanks/Fuel Tank.SLDASM"), Local(bob, "Hopper/Hopper Payload.SLDPRT")]);
        Assert.Equal(Local(bob, "Hopper/Tanks/Fuel Tank.SLDASM"), bob.LocalFileFor(Local(bob, "09_Hopper/Tanks/Fuel Tank.SLDASM"), vaultPaths));
        Assert.Null(bob.LocalFileFor(Local(bob, "09_Hopper/Hopper Payload.SLDPRT"), vaultPaths)); // its copy is here, but has only its name in common
    }

    [Fact]
    public async Task OpeningAnAssemblySavedAgainstDeletedFilesGetsTheirCopiesAtEveryLevel()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await UploadedAgainAsync(alice, "LOX");
        await bob.GetLatestAsync([Local(bob, "Hopper/Assy - Vehicle.SLDASM")]);
        var keeps = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["Assy - Vehicle.SLDASM"] = [Local(bob, "09_Hopper/Tanks/LOX Tank.SLDASM"), Local(bob, "09_Hopper/Hopper Payload.SLDPRT")],
            ["LOX Tank.SLDASM"] = [Local(bob, "Hopper/Tanks/LOX Baffle.SLDPRT")], // saved since, where its part is now
        };

        var (got, notInVault) = await bob.GetUsedFilesAsync(
            Local(bob, "Hopper/Assy - Vehicle.SLDASM"), path => keeps.TryGetValue(Path.GetFileName(path), out var paths) ? paths : [], latest: false);

        Assert.Equal(["LOX Baffle.SLDPRT", "LOX Tank.SLDASM"], got.Downloaded.Select(Name).Order());
        Assert.Equal("tank", File.ReadAllText(Local(bob, "Hopper/Tanks/LOX Tank.SLDASM")));
        Assert.Equal([Local(bob, "09_Hopper/Hopper Payload.SLDPRT")], notInVault);
    }

    [Fact]
    public async Task WhatFilesKeepIsReadOnTheCallersThread()
    {
        // The add-in reads them from SolidWorks, which only answers on its main thread: the task pane's.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var kept = await FromKenestoAsync(alice);
        await bob.GetLatestAsync([Local(bob, "09_Hopper/Assy - Vehicle.SLDASM")]);
        var context = new PoolContext();
        var elsewhere = new List<string>();
        var read = new List<string>();

        await Task.Run(() =>
        {
            SynchronizationContext.SetSynchronizationContext(context);
            try
            {
                return bob.GetUsedFilesAsync(
                    Local(bob, "09_Hopper/Assy - Vehicle.SLDASM"),
                    path =>
                    {
                        (SynchronizationContext.Current == context ? read : elsewhere).Add(Path.GetFileName(path));
                        return kept(path);
                    },
                    latest: true);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(null);
            }
        });

        Assert.Empty(elsewhere);
        Assert.Contains("Stringer.SLDPRT", read); // after it came down
    }

    /// <summary>
    /// A folder brought over from Kenesto, checked in by this person: an assembly using its own part and a sub-assembly,
    /// which uses two parts in a subfolder and one that wasn't brought over. And the paths each file keeps for what it
    /// uses, Kenesto's, as SolidWorks would read them (by file name: the same in every workspace).
    /// </summary>
    private async Task<Func<string, IEnumerable<string>>> FromKenestoAsync(Workspace workspace)
    {
        var kenesto = $@"K:\Yellow Jacket Space Program\Project CAD\{_folder}\09_Hopper";
        await workspace.CheckinAsync(
            [
                Write(workspace, "09_Hopper/Assy - Vehicle.SLDASM", "assembly"),
                Write(workspace, "09_Hopper/Leg.SLDPRT", "leg"),
                Write(workspace, "09_Hopper/Thrust Structure.SLDASM", "sub-assembly"),
                Write(workspace, "09_Hopper/Gimbal/Gimbal Ring.SLDPRT", "ring"),
                Write(workspace, "09_Hopper/Gimbal/Stringer.SLDPRT", "stringer"),
            ],
            "from Kenesto");
        var keeps = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["Assy - Vehicle.SLDASM"] = [$@"{kenesto}\Thrust Structure.SLDASM", $@"{kenesto}\Leg.SLDPRT"],
            ["Thrust Structure.SLDASM"] = [$@"{kenesto}\Gimbal\Gimbal Ring.SLDPRT", $@"{kenesto}\Gimbal\Stringer.SLDPRT", $@"{kenesto}\Nozzle.SLDPRT"],
        };
        return path => keeps.TryGetValue(Path.GetFileName(path), out var paths) ? paths : [];
    }

    /// <summary>
    /// 09_Hopper uploaded again as Hopper by this person, and the old copies deleted, as the team once did: what was in
    /// 09_Hopper is in the trash, and Hopper has a copy of each, one in a folder of the same name and one not, and the
    /// tank's part beside it. Tests name their own tanks: a deleted file's path is matched only up to the renamed
    /// folder, so two tests' tanks, each in its own test folder, would end as alike, on the server they share.
    /// </summary>
    private async Task UploadedAgainAsync(Workspace workspace, string tank)
    {
        string[] old = [$"09_Hopper/Tanks/{tank} Tank.SLDASM", "09_Hopper/Hopper Payload.SLDPRT"];
        await workspace.CheckinAsync([.. old.Select(path => Write(workspace, path, "old"))], "the old tree");
        await workspace.CheckinAsync(
            [
                Write(workspace, "Hopper/Assy - Vehicle.SLDASM", "vehicle"),
                Write(workspace, $"Hopper/Tanks/{tank} Tank.SLDASM", "tank"),
                Write(workspace, $"Hopper/Tanks/{tank} Baffle.SLDPRT", "baffle"),
                Write(workspace, "Hopper/Hopper Payload.SLDPRT", "payload"),
            ],
            "uploaded again");
        await workspace.Api.DeleteAsync(old.Select(path => $"{_folder}/{path}"));
    }

    [Fact]
    public async Task ACheckinNamesEveryFileItUsesThatTheVaultCantHave()
    {
        var alice = await WorkspaceAsync("alice");
        var downloaded = Path.Combine(_temp, "Downloads", "Relief Valve.SLDPRT"); // here, outside the workspace
        Directory.CreateDirectory(Path.GetDirectoryName(downloaded)!);
        File.WriteAllText(downloaded, "valve");
        string[] kenesto = [@"K:\Project CAD\YJSP Library\Tee.SLDPRT", @"K:\Project CAD\YJSP Library\Cross.SLDPRT"]; // nowhere
        var vehicle = Write(alice, "Vehicle.SLDASM", "assembly");

        var error = await Assert.ThrowsAsync<WorkspaceException>(
            () => alice.CheckinAsync([vehicle], "vehicle", referencesOf: _ => [.. kenesto, downloaded]));

        Assert.StartsWith($"{_folder}/Vehicle.SLDASM can't be checked in", error.Message, StringComparison.Ordinal);
        Assert.Contains($"take them out of what uses them:{Environment.NewLine}  {kenesto[0]}{Environment.NewLine}  {kenesto[1]}", error.Message, StringComparison.Ordinal);
        Assert.Contains($"outside the workspace: move it into {alice.Root} (for example with Pack and Go):{Environment.NewLine}  {downloaded}", error.Message, StringComparison.Ordinal);
        Assert.Equal(FileState.New, Assert.Single(await alice.StatusAsync([vehicle])).State); // nothing was checked in
    }

    [Fact]
    public async Task GetLatestCarriesOnPastFilesItCannotReplace()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // uses Unix folder permissions to make one file impossible to replace
        }
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var stuck = Write(alice, "Stuck/A.STEP", "a1");
        var free = Write(alice, "Free/B.STEP", "b1");
        await alice.CheckinAsync([Folder(alice)], "add a and b");
        await bob.GetLatestAsync([Folder(bob)]);
        await alice.CheckoutAsync([Folder(alice)]);
        File.WriteAllText(stuck, "a2");
        File.WriteAllText(free, "b2");
        await alice.CheckinAsync([Folder(alice)], "update both");

        var locked = Path.GetDirectoryName(Local(bob, "Stuck/A.STEP"))!;
        File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            var result = await bob.GetLatestAsync([Folder(bob)]);
            Assert.Contains("A.STEP", Assert.Single(result.Failures), StringComparison.Ordinal);
            Assert.Equal("b2", File.ReadAllText(Local(bob, "Free/B.STEP")));
        }
        finally
        {
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Fact]
    public async Task AFileAGetDidntBringSaysWhy()
    {
        // Opening a file from a link gets it first: when it isn't here after that, saying it isn't in the vault would be
        // wrong if its download failed.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync([Write(alice, "Fin.SLDPRT", "fin"), Write(alice, "Fin Can.SLDASM", "can")], "add fin and can");

        var fin = Local(bob, "Fin.SLDPRT");
        Assert.Null(bob.WhyNotHere(fin, await bob.GetLatestAsync([fin])));

        var nowhere = Local(bob, "Nowhere.SLDPRT");
        Assert.Equal(
            $"{_folder}/Nowhere.SLDPRT isn't in the vault, or you don't have access to it.",
            bob.WhyNotHere(nowhere, await bob.GetLatestAsync([nowhere])));

        // Something in the way that isn't the file: its download can't be put there. Gets made of several gets (the
        // file, then what it uses) still know which file failed, and why.
        var can = Local(bob, "Fin Can.SLDASM");
        Directory.CreateDirectory(can);
        var got = new GetResult();
        got.Add(await bob.GetLatestAsync([can]));
        got.Add(await bob.GetLatestAsync([fin]));
        Assert.StartsWith($"Can't replace {can}: ", bob.WhyNotHere(can, got), StringComparison.Ordinal);
        Assert.Equal(
            $"Vault couldn't get {_folder}/Fin Can.SLDASM. Try again.",
            bob.WhyNotHere(can, new GetResult())); // without the get that failed, all it can say
    }

    [Fact]
    public async Task FreeingUpSpaceRemovesOnlyCopiesTheVaultHasAsTheyAre()
    {
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        Write(alice, "Fins/Fin.SLDPRT", "fin");
        Write(alice, "Fins/Can.SLDASM", "can");
        Write(alice, "Nose.SLDPRT", "nose");
        Write(alice, "Tail.SLDPRT", "tail");
        await alice.CheckinAsync([Folder(alice)], "the airframe");
        await bob.GetLatestAsync([Folder(bob)]);
        await bob.CheckoutAsync([Local(bob, "Nose.SLDPRT"), Local(bob, "Tail.SLDPRT")]);
        File.WriteAllText(Local(bob, "Nose.SLDPRT"), "bob's nose"); // changed; the tail he hasn't changed yet
        var bracket = Write(bob, "Fins/Bracket.SLDPRT", "bracket"); // only his so far
        // A newer fin: Bob's copy is out of date, but still as it came, so it can go too.
        await alice.CheckoutAsync([Local(alice, "Fins/Fin.SLDPRT")]);
        File.WriteAllText(Local(alice, "Fins/Fin.SLDPRT"), "fin v2");
        await alice.CheckinAsync([Local(alice, "Fins/Fin.SLDPRT")], "a longer fin");

        Assert.Equal((2, 6L), await bob.SizeOfFreeUpAsync([Folder(bob)]));
        var freed = await bob.FreeUpAsync([Folder(bob)]);
        Assert.Equal(["Can.SLDASM", "Fin.SLDPRT"], freed.Removed.Select(s => Path.GetFileName(s.LocalPath)).Order());
        Assert.Equal(6, freed.Bytes);
        Assert.Empty(freed.Failures);
        Assert.False(File.Exists(Local(bob, "Fins/Fin.SLDPRT")));
        Assert.Equal("bob's nose", File.ReadAllText(Local(bob, "Nose.SLDPRT")));
        Assert.True(File.Exists(Local(bob, "Tail.SLDPRT")));
        Assert.True(File.Exists(bracket));
        var fin = (await bob.StatusAsync([Folder(bob)])).Single(s => s.VaultPath.EndsWith("/Fins/Fin.SLDPRT", StringComparison.Ordinal));
        Assert.Equal(FileState.Missing, fin.State);

        // Updating what's here leaves freed files in the vault; getting one brings it back, at its latest.
        await bob.UpdateAsync([Folder(bob)]);
        Assert.False(File.Exists(Local(bob, "Fins/Fin.SLDPRT")));
        await bob.GetLatestAsync([Local(bob, "Fins/Fin.SLDPRT")]);
        Assert.Equal("fin v2", File.ReadAllText(Local(bob, "Fins/Fin.SLDPRT")));
        Assert.True(IsReadOnly(Local(bob, "Fins/Fin.SLDPRT")));
    }

    [Fact]
    public async Task FreeingUpSpaceLeavesWhatsInUse()
    {
        var alice = await WorkspaceAsync("alice");
        var open = Write(alice, "Open.SLDPRT", "open");
        var held = Write(alice, "Held.SLDPRT", "held");
        var elsewhere = Write(alice, "Elsewhere/Other.SLDPRT", "other");
        await alice.CheckinAsync([Folder(alice)], "three parts");

        Assert.Equal((1, 5L), await alice.SizeOfFreeUpAsync([Path.GetDirectoryName(elsewhere)!])); // only under the paths named
        // What the add-in says SolidWorks has open stays; so does a copy something holds, with why.
        using (HoldOpen(held))
        {
            var freed = await alice.FreeUpAsync([Folder(alice)], inUse: path => Path.GetFileName(path) == "Open.SLDPRT");
            Assert.Equal(["Other.SLDPRT"], freed.Removed.Select(s => Path.GetFileName(s.LocalPath)));
            Assert.Contains("Held.SLDPRT", Assert.Single(freed.Failures), StringComparison.Ordinal);
        }
        Assert.True(File.Exists(open));
        Assert.True(IsReadOnly(held)); // still there, and still not checked out
        Assert.Equal(FileState.UpToDate, Assert.Single(await alice.StatusAsync([held])).State);
    }

    [Fact]
    public async Task BadNamesAreRejectedBeforeUploading()
    {
        var alice = await WorkspaceAsync("alice");
        var bad = Write(alice, " Main chute.STEP", "x"); // a leading space: Windows keeps it, the vault doesn't allow it
        await Assert.ThrowsAsync<VaultPathException>(() => alice.CheckinAsync([bad], "bad name"));
    }

    private async Task<Workspace> WorkspaceAsync(string person, HttpMessageHandler? handler = null)
    {
        var token = await _server.MemberTokenAsync($"{person}@rocketry.test");
        var workspace = Workspace.Create(Path.Combine(_temp, person), _server.Url, token, host: person.ToUpperInvariant() + "-PC", handler: handler);
        _workspaces.Add(workspace);
        return workspace;
    }

    private static string Name(FileStatus status) => status.VaultPath.Substring(status.VaultPath.LastIndexOf('/') + 1);

    private string Folder(Workspace workspace) => Path.Combine(workspace.Root, _folder);

    private string Local(Workspace workspace, string relative) =>
        Path.Combine(workspace.Root, _folder, relative.Replace('/', Path.DirectorySeparatorChar));

    private string Write(Workspace workspace, string relative, string contents)
    {
        var path = Local(workspace, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, contents);
        return path;
    }

    private static bool IsReadOnly(string path) => (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0;

    /// <summary>Stop a file from being replaced until disposed, as SolidWorks does while it has the file open.</summary>
    private static IDisposable HoldOpen(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            // Like SolidWorks: others can read it (so it can be backed up), not replace or move it. It opens
            // read-only files for reading.
            var access = IsReadOnly(path) ? FileAccess.Read : FileAccess.ReadWrite;
            return new FileStream(path, FileMode.Open, access, FileShare.Read);
        }
        return new ReadOnlyFolder(Path.GetDirectoryName(path)!);
    }

    // Unix lets a file be replaced while it's open, but not inside a read-only folder.
    [UnsupportedOSPlatform("windows")]
    private sealed class ReadOnlyFolder : IDisposable
    {
        private readonly string _folder;

        public ReadOnlyFolder(string folder)
        {
            _folder = folder;
            File.SetUnixFileMode(folder, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        }

        public void Dispose() => File.SetUnixFileMode(_folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    /// <summary>Runs what's posted to it on the thread pool, as itself: it stands in for the task pane's thread.</summary>
    private sealed class PoolContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state) =>
            ThreadPool.QueueUserWorkItem(_ =>
            {
                SetSynchronizationContext(this);
                try
                {
                    d(state);
                }
                finally
                {
                    SetSynchronizationContext(null);
                }
            });
    }

    private static void MakeWritable(string path) => File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);

    /// <summary>What each request on its way to the server said its person is doing, if anything.</summary>
    private sealed class SentActivity : DelegatingHandler
    {
        private readonly List<string?> _sent = new List<string?>();

        public SentActivity()
            : base(new HttpClientHandler())
        {
        }

        /// <summary>Each request's so far, in order.</summary>
        public List<string?> Sent
        {
            get
            {
                lock (_sent)
                {
                    return _sent.ToList();
                }
            }
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            lock (_sent)
            {
                _sent.Add(request.Headers.TryGetValues("X-YJSP-Activity", out var values) ? string.Join(",", values) : null);
            }
            return base.SendAsync(request, cancellationToken);
        }
    }

    /// <summary>The server as the release before it said what files use: its answers without "uses".</summary>
    private sealed class OlderServer : DelegatingHandler
    {
        public OlderServer()
            : base(new HttpClientHandler())
        {
        }

        public bool IsOlder { get; set; } = true;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            if (IsOlder && response.Content.Headers.ContentType?.MediaType == "application/json")
            {
                var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
                WithoutUses(json);
                response.Content = new StringContent(json?.ToJsonString() ?? "null", Encoding.UTF8, "application/json");
            }
            return response;
        }

        private static void WithoutUses(JsonNode? node)
        {
            if (node is JsonObject item)
            {
                item.Remove("uses");
                foreach (var child in item.Select(pair => pair.Value).ToList())
                {
                    WithoutUses(child);
                }
            }
            else if (node is JsonArray items)
            {
                foreach (var child in items)
                {
                    WithoutUses(child);
                }
            }
        }
    }
}
