using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace Vault.Client.Tests;

/// <summary>
/// Paths from a server that isn't the team's, or isn't working right: a workspace puts nothing outside itself or in its
/// own .vault folder, and keeps nothing from an answer with a path that would. The real server, with a stand-in in front
/// of it that changes what it says (RogueServer).
/// </summary>
[Collection("server")]
public sealed class ServerPathTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-paths-" + Guid.NewGuid().ToString("N"));
    private readonly string _folder = "Test-" + Guid.NewGuid().ToString("N").Substring(0, 8);
    private readonly List<Workspace> _workspaces = new List<Workspace>();
    private readonly Dictionary<Workspace, string> _tokens = new Dictionary<Workspace, string>();

    public ServerPathTests(ServerFixture server) => _server = server;

    public void Dispose()
    {
        _workspaces.ForEach(w => w.Dispose());
        TempFolders.Delete(_temp);
    }

    [Theory]
    // {0}: the test's vault folder; {1}: the folder the workspaces are in, from the top of the disk. Each would put the
    // file beside the workspaces, in that folder, or in the workspace's own .vault.
    [InlineData("{0}/../../Escaped.STEP")]
    [InlineData("{0}\\..\\..\\Escaped.STEP")]
    [InlineData("{1}/Escaped.STEP")]
    [InlineData(".vault/Escaped.STEP")]
    public async Task FilesOutsideTheWorkspaceAreRefused(string sent)
    {
        var alice = await WorkspaceAsync("alice");
        var rogue = new RogueServer();
        var bob = await WorkspaceAsync("bob", rogue);
        await alice.CheckinAsync([Write(alice, "Fin.STEP", "fin")], "add fin");
        var bad = string.Format(CultureInfo.InvariantCulture, sent, _folder, _temp.Replace('\\', '/'));
        rogue.Rewrite = (_, path) => path == $"{_folder}/Fin.STEP" ? bad : path;

        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => bob.GetLatestAsync([Folder(bob)]));
        Assert.Contains("sent a bad path", refused.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_temp, "Escaped.STEP")));
        Assert.False(File.Exists(Path.Combine(bob.Root, ".vault", "Escaped.STEP")));
        Assert.Empty(Directory.GetFiles(bob.Root, "*Escaped*", SearchOption.AllDirectories));

        // Nothing from that answer was kept: from the server as it is, the file comes where it belongs.
        rogue.Rewrite = null;
        await bob.GetLatestAsync([Folder(bob)]);
        Assert.Equal("fin", File.ReadAllText(Local(bob, "Fin.STEP")));
    }

    [Fact]
    public async Task FoldersOutsideTheWorkspaceAreRefused()
    {
        var alice = await WorkspaceAsync("alice");
        var rogue = new RogueServer();
        var bob = await WorkspaceAsync("bob", rogue);
        await alice.CheckinAsync([Write(alice, "Sub/Part.STEP", "part")], "add part");
        rogue.Rewrite = (_, path) => path == $"{_folder}/Sub" ? $"{_folder}/../../Escaped" : path;

        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => bob.RefreshAsync());
        Assert.Contains("sent a bad path", refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(Path.Combine(_temp, "Escaped")));
    }

    [Fact]
    public async Task CopiesDontFollowAMoveOutOfTheWorkspace()
    {
        var alice = await WorkspaceAsync("alice");
        var rogue = new RogueServer();
        var bob = await WorkspaceAsync("bob", rogue);
        var aliceFin = Write(alice, "Fin.STEP", "fin");
        await alice.CheckinAsync([aliceFin], "add fin");
        await bob.GetLatestAsync([Folder(bob)]);

        // The server says the fin moved out of the workspace (with a change, so the next sync has it).
        rogue.Rewrite = (_, path) => path == $"{_folder}/Fin.STEP" ? $"{_folder}/../../Moved.STEP" : path;
        await alice.CheckoutAsync([aliceFin]);
        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => bob.StatusAsync([Folder(bob)]));
        Assert.Contains("sent a bad path", refused.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_temp, "Moved.STEP")));
        Assert.Equal("fin", File.ReadAllText(Local(bob, "Fin.STEP")));
    }

    [Fact]
    public async Task AFileSentAtAnotherFilesPathDoesntReplaceYourChanges()
    {
        // A server can say two files are at one path (and on Windows, two paths can be one file: FINCAN~1.SLD is Fin
        // Can.SLDASM). Getting the one that isn't here doesn't replace the one that is.
        var alice = await WorkspaceAsync("alice");
        var rogue = new RogueServer();
        var bob = await WorkspaceAsync("bob", rogue);
        await alice.CheckinAsync([Write(alice, "Fin.STEP", "fin"), Write(alice, "Other.STEP", "other")], "add two");
        var bobFin = Local(bob, "Fin.STEP");
        await bob.GetLatestAsync([bobFin]);
        await bob.CheckoutAsync([bobFin]);
        File.WriteAllText(bobFin, "bob's fin");

        rogue.Rewrite = (_, path) => path == $"{_folder}/Other.STEP" ? $"{_folder}/Fin.STEP" : path;
        await alice.CheckoutAsync([Local(alice, "Other.STEP")]); // so the next sync has it
        var result = await bob.GetLatestAsync([Folder(bob)]);
        Assert.Contains(result.Failures, failure => failure.Contains("there's another file", StringComparison.Ordinal));
        Assert.Equal("bob's fin", File.ReadAllText(bobFin));
    }

    [Fact]
    public async Task AnswersToCheckOutsAndCheckInsAreCheckedToo()
    {
        var rogue = new RogueServer();
        var bob = await WorkspaceAsync("bob", rogue);
        var fin = Write(bob, "Fin.STEP", "fin");
        var bad = $"{_folder}/../../Escaped.STEP";

        rogue.Rewrite = (request, path) => request.EndsWith("/api/checkin", StringComparison.Ordinal) ? bad : path;
        var checkin = await Assert.ThrowsAsync<WorkspaceException>(() => bob.CheckinAsync([fin], "add fin"));
        Assert.Contains("sent a bad path", checkin.Message, StringComparison.Ordinal);

        rogue.Rewrite = (request, path) => request.EndsWith("/api/checkout", StringComparison.Ordinal) ? bad : path;
        var checkout = await Assert.ThrowsAsync<WorkspaceException>(() => bob.CheckoutAsync([fin]));
        Assert.Contains("sent a bad path", checkout.Message, StringComparison.Ordinal);

        // What the server did is real (the fin is in the vault, checked out to Bob): it shows from a server as it is.
        rogue.Rewrite = null;
        var status = Assert.Single(await bob.StatusAsync([fin]));
        Assert.Equal((FileState.UpToDate, true), (status.State, status.CheckedOutByMe));
        Assert.False(File.Exists(Path.Combine(_temp, "Escaped.STEP")));
    }

    [Fact]
    public async Task PathsKeptFromBeforeAreForgotten()
    {
        // A workspace an older client kept, with a path a server sent it: the fin's copy came from outside it.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        await alice.CheckinAsync([Write(alice, "Fin.STEP", "fin")], "add fin");
        await bob.GetLatestAsync([Folder(bob)]);
        var id = Assert.Single(await bob.StatusAsync([Folder(bob)])).FileId!.Value;
        var outside = Path.Combine(_temp, "Outside.STEP");
        File.WriteAllText(outside, "not the vault's");
        var stateFile = Path.Combine(bob.Root, ".vault", "state.json");
        var state = JsonNode.Parse(File.ReadAllText(stateFile))!;
        state["local"]![id.ToString(CultureInfo.InvariantCulture)]!["path"] = $"{_folder}/../../Outside.STEP";
        File.WriteAllText(stateFile, state.ToJsonString());
        File.SetAttributes(Local(bob, "Fin.STEP"), FileAttributes.Normal);
        File.Delete(Local(bob, "Fin.STEP"));

        using var reopened = Workspace.Open(bob.Root, _tokens[bob]);
        var status = Assert.Single(await reopened.StatusAsync([Folder(bob)]));
        Assert.Equal(FileState.Missing, status.State); // not the file from outside, moved in
        Assert.Equal("not the vault's", File.ReadAllText(outside));
        await reopened.GetLatestAsync([Folder(bob)]);
        Assert.Equal("fin", File.ReadAllText(Local(bob, "Fin.STEP")));
    }

    [Fact]
    public async Task PathsTheServerMakesLongerThanTheLimitAreFine()
    {
        // The server checks the limit as files are added, moved, and renamed, but a file restored into a folder renamed
        // since can pass it: that's no danger, only long, so it syncs like any other.
        var alice = await WorkspaceAsync("alice");
        var bob = await WorkspaceAsync("bob");
        var name = new string('n', 60) + ".STEP";
        await alice.CheckinAsync([Write(alice, $"A/{name}", "long")], "add it");
        var id = Assert.Single(await alice.StatusAsync([Folder(alice)])).FileId!.Value;
        using (var http = _server.Http(_server.ChiefToken))
        {
            (await http.PostAsJsonAsync("api/delete", new { files = new[] { $"{_folder}/A/{name}" } })).EnsureSuccessStatusCode();
            (await http.PostAsJsonAsync("api/rename", new { folder = $"{_folder}/A", name = new string('a', 150) })).EnsureSuccessStatusCode();
            (await http.PostAsync($"api/files/{id}/restore", null)).EnsureSuccessStatusCode();
        }

        var status = Assert.Single(await bob.StatusAsync([Folder(bob)]));
        Assert.True(status.VaultPath.Length > VaultPaths.MaxPath);
        Assert.Equal(FileState.Missing, status.State);
        Assert.StartsWith(bob.Root + Path.DirectorySeparatorChar, status.LocalPath, StringComparison.Ordinal);
    }

    private async Task<Workspace> WorkspaceAsync(string person, HttpMessageHandler? handler = null)
    {
        var token = await _server.MemberTokenAsync($"{person}@rocketry.test");
        var workspace = Workspace.Create(Path.Combine(_temp, person), _server.Url, token, host: person.ToUpperInvariant() + "-PC", handler: handler);
        _workspaces.Add(workspace);
        _tokens[workspace] = token;
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

    /// <summary>
    /// The real server, with what it says changed on the way, as a server that isn't the team's (or has been broken
    /// into) could say it: Rewrite has each path in its answers say something else.
    /// </summary>
    private sealed class RogueServer : DelegatingHandler
    {
        public RogueServer()
            : base(new HttpClientHandler())
        {
        }

        /// <summary>(The request's path, like "/api/sync"; a "path" in its answer) → what the answer says instead.</summary>
        public Func<string, string, string>? Rewrite { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            if (Rewrite is { } rewrite && response.Content.Headers.ContentType?.MediaType == "application/json")
            {
                var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
                Change(json, path => rewrite(request.RequestUri!.AbsolutePath, path));
                response.Content = new StringContent(json?.ToJsonString() ?? "null", Encoding.UTF8, "application/json");
            }
            return response;
        }

        private static void Change(JsonNode? node, Func<string, string> rewrite)
        {
            if (node is JsonObject item)
            {
                if (item["path"] is JsonValue value && value.TryGetValue<string>(out var path))
                {
                    item["path"] = rewrite(path);
                }
                foreach (var child in item.Select(pair => pair.Value).ToList())
                {
                    Change(child, rewrite);
                }
            }
            else if (node is JsonArray items)
            {
                foreach (var child in items)
                {
                    Change(child, rewrite);
                }
            }
        }
    }
}

/// <summary>Where a workspace puts a vault path: inside itself, by the vault's rules, or nowhere.</summary>
public sealed class LocalPathTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "vault-local-" + Guid.NewGuid().ToString("N"));
    private readonly Workspace _workspace;

    public LocalPathTests() => _workspace = Workspace.Create(_root, new Uri("https://yjsp.example.org/"), "token");

    public void Dispose()
    {
        _workspace.Dispose();
        TempFolders.Delete(_root);
    }

    [Theory]
    [InlineData("Structures/Fins/Fin.SLDPRT", "Structures", "Fins", "Fin.SLDPRT")]
    [InlineData("Parts/.vault/Notes.txt", "Parts", ".vault", "Notes.txt")] // only the top's .vault is the workspace's
    [InlineData("Parts/VAULT~1", "Parts", "VAULT~1")]
    [InlineData("Me\u0301canique.STEP", "M\u00e9canique.STEP")] // NFC, as the vault keeps names
    public void VaultPathsAreInTheWorkspace(string vaultPath, params string[] names) =>
        Assert.Equal(Path.Combine([_workspace.Root, .. names]), _workspace.ToLocalPath(vaultPath));

    [Fact]
    public void TheTopOfTheVaultIsTheWorkspace() => Assert.Equal(_workspace.Root, _workspace.ToLocalPath(""));

    [Fact]
    public void PathsLongerThanTheLimitAreInTheWorkspaceToo()
    {
        var vaultPath = string.Join("/", Enumerable.Repeat("aaaaaaaaa", 30)); // 299 characters: see PathsTheServerMakesLongerThanTheLimitAreFine
        Assert.Equal(Path.Combine([_workspace.Root, .. vaultPath.Split('/')]), _workspace.ToLocalPath(vaultPath));
    }

    [Theory]
    [InlineData("../Escaped.STEP")]
    [InlineData("Fins/../../Escaped.STEP")]
    [InlineData("Fins/./Fin.SLDPRT")]
    [InlineData("..\\Escaped.STEP")]
    [InlineData("Fins\\Fin.SLDPRT")] // only '/' separates names in a vault path
    [InlineData("/etc/passwd")]
    [InlineData("C:/Windows/win.ini")]
    [InlineData("C:")]
    [InlineData("\\\\server\\share\\Fin.SLDPRT")]
    [InlineData("Fins//Fin.SLDPRT")]
    [InlineData("Fins/")]
    [InlineData("Fin.SLDPRT:hidden")] // an NTFS stream
    [InlineData("Fins/CON")]
    [InlineData("Fins/Fin.SLDPRT ")]
    [InlineData("Fins./Fin.SLDPRT")]
    [InlineData("Fins/\u0001.STEP")]
    [InlineData(".vault")]
    [InlineData(".vault/state.json")]
    [InlineData(".VAULT/config.json")]
    [InlineData("VAULT~1/state.json")] // .vault's short name, on Windows
    [InlineData("vault~12")]
    public void AnythingElseIsRefused(string vaultPath) =>
        Assert.Throws<VaultPathException>(() => _workspace.ToLocalPath(vaultPath));
}
