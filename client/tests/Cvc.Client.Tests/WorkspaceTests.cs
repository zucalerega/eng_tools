namespace Cvc.Client.Tests;

/// <summary>Two people's workspaces against a real server: the everyday check-out/check-in loop.</summary>
[Collection("server")]
public sealed class WorkspaceTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "cvc-workspaces-" + Guid.NewGuid().ToString("N"));
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

        var taken = await Assert.ThrowsAsync<CvcApiException>(() => bob.CheckoutAsync([Local(bob, "Nosecone.SLDPRT")]));
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
    public async Task BadNamesAreRejectedBeforeUploading()
    {
        var alice = await WorkspaceAsync("alice");
        var bad = Write(alice, " Main chute.STEP", "x"); // a leading space: Windows keeps it, the vault doesn't allow it
        await Assert.ThrowsAsync<VaultPathException>(() => alice.CheckinAsync([bad], "bad name"));
    }

    private async Task<Workspace> WorkspaceAsync(string person)
    {
        var token = await _server.MemberTokenAsync($"{person}@rocketry.test");
        var workspace = Workspace.Create(Path.Combine(_temp, person), _server.Url, token, host: person.ToUpperInvariant() + "-PC");
        _workspaces.Add(workspace);
        return workspace;
    }

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

    private static void MakeWritable(string path) => File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
}
