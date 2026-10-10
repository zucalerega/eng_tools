using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Vault.Client;

/// <summary>
/// A local copy of the vault (default C:\VLT) and everything you do with it: status, get
/// latest, check out, check in, undo. Every machine uses the same root, so the absolute paths
/// SolidWorks stores for references resolve everywhere. Files you don't have checked out are
/// read-only, so SolidWorks opens them read-only. Local changes are never overwritten without
/// a copy in .vault/backup first.
/// </summary>
public sealed class Workspace : IDisposable
{
    public const string MetaFolder = ".vault";

    /// <summary>What the web app calls itself where a computer's name goes: check-outs and check-ins there are on it.</summary>
    public const string WebHost = "web";
    internal const string DownloadSuffix = ".vault-download";
    private const string ConfigFile = "config.json";
    private const string StateFile = "state.json";
    private static readonly string[] MayReference = { ".sldasm", ".slddrw", ".sldprt" };

    private readonly WorkspaceState _state;
    private Account? _me;

    private Workspace(string root, Uri server, string host, VaultApi api, WorkspaceState state)
    {
        Root = root;
        Server = server;
        Host = host;
        Api = api;
        _state = state;
    }

    public string Root { get; }

    public Uri Server { get; }

    /// <summary>This computer's name; check-outs belong to it.</summary>
    public string Host { get; }

    public VaultApi Api { get; }

    public static string DefaultRoot => RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
        ? @"C:\VLT"
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "VLT");

    public void Dispose() => Api.Dispose();

    // --- creating and opening -------------------------------------------------------------

    public static Workspace Create(string root, Uri server, string token, string? host = null, HttpMessageHandler? handler = null)
    {
        root = Path.GetFullPath(root);
        var existing = FindRoot(root);
        if (existing != null)
        {
            throw new WorkspaceException($"{existing} is already a vault workspace");
        }
        var meta = Path.Combine(root, MetaFolder);
        Directory.CreateDirectory(meta);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            File.SetAttributes(meta, File.GetAttributes(meta) | FileAttributes.Hidden);
        }
        var config = new WorkspaceConfig { Server = VaultApi.WithTrailingSlash(server).AbsoluteUri, Host = host };
        WriteJson(Path.Combine(meta, ConfigFile), config);
        return Open(root, token, handler);
    }

    public static Workspace Open(string root, string token, HttpMessageHandler? handler = null)
    {
        root = Path.GetFullPath(root);
        var config = ReadJson<WorkspaceConfig>(Path.Combine(root, MetaFolder, ConfigFile))
            ?? throw new WorkspaceException($"{root} is not a vault workspace");
        var statePath = Path.Combine(root, MetaFolder, StateFile);
        var state = File.Exists(statePath) ? ReadJson<WorkspaceState>(statePath) ?? new WorkspaceState() : new WorkspaceState();
        var server = new Uri(config.Server);
        return new Workspace(root, server, config.Host ?? Environment.MachineName, new VaultApi(server, token, handler), state);
    }

    /// <summary>The workspace containing a path (like git finding .git), or null.</summary>
    public static string? FindRoot(string path)
    {
        var full = Path.GetFullPath(path);
        for (var dir = File.Exists(full) ? Path.GetDirectoryName(full) : full; dir != null; dir = Path.GetDirectoryName(dir))
        {
            if (File.Exists(Path.Combine(dir, MetaFolder, ConfigFile)))
            {
                return dir;
            }
        }
        return null;
    }

    public static Uri ServerOf(string root) =>
        new Uri((ReadJson<WorkspaceConfig>(Path.Combine(root, MetaFolder, ConfigFile))
            ?? throw new WorkspaceException($"{root} is not a vault workspace")).Server);

    // --- paths ------------------------------------------------------------------------------

    /// <summary>The vault path of a local file or folder in this workspace ("" for the root).</summary>
    public string ToVaultPath(string localPath) => string.Join("/", VaultPaths.Split(RelativePath(localPath)));

    public string ToLocalPath(string vaultPath) =>
        vaultPath.Length == 0 ? Root : Path.Combine(Root, vaultPath.Replace('/', Path.DirectorySeparatorChar));

    private string RelativePath(string localPath)
    {
        var full = Path.GetFullPath(localPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var root = Root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
        {
            return "";
        }
        var prefix = root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new WorkspaceException($"{localPath} is outside the workspace {Root}");
        }
        return full.Substring(prefix.Length).Replace('\\', '/');
    }

    private List<string> Scope(IEnumerable<string>? localPaths)
    {
        var keys = (localPaths ?? Enumerable.Empty<string>()).Select(p => VaultPaths.Key(ToVaultPath(p))).ToList();
        return keys.Count == 0 || keys.Contains("") ? new List<string> { "" } : keys;
    }

    private static bool InScope(string key, List<string> scope) =>
        scope.Any(s => s.Length == 0 || key == s || key.StartsWith(s + "/", StringComparison.Ordinal));

    // --- reading ----------------------------------------------------------------------------

    /// <summary>Fetch what changed in the vault since the last refresh.</summary>
    public async Task RefreshAsync(CancellationToken ct = default)
    {
        _me ??= await Api.MeAsync(ct).ConfigureAwait(false);
        var current = _state.SyncFormat == WorkspaceState.CurrentSyncFormat;
        var sync = await Api.SyncAsync(current ? _state.Seq : 0, ct).ConfigureAwait(false);
        var before = sync.Full ? _state.Folders.Values.Select(f => f.Path).ToList() : new List<string>();
        if (sync.Full)
        {
            _state.Remote.Clear();
            _state.Folders.Clear();
            _state.SyncFormat = WorkspaceState.CurrentSyncFormat;
        }
        foreach (var folder in sync.Folders)
        {
            _state.Folders[VaultPaths.Key(folder.Path)] = new FolderEntry { Path = folder.Path, Role = folder.Role };
        }
        foreach (var file in sync.Files)
        {
            if (file.DeletedAt != null)
            {
                _state.Remote.Remove(file.Id);
            }
            else
            {
                _state.Remote[file.Id] = RemoteEntry.From(file);
            }
        }
        // Synced while the server didn't say what files use (it was older): now it does, so get it all again.
        if (!sync.Full && sync.Files.Any(f => f.Uses != null) && _state.Remote.Values.Any(r => r.Uses == null))
        {
            _state.SyncFormat = 0;
            await RefreshAsync(ct).ConfigureAwait(false);
            return;
        }
        _state.Seq = sync.Seq;
        FollowMoves();
        MirrorFolders(sync.Folders.Select(f => f.Path), before);
        SaveState();
    }

    /// <summary>
    /// Make the vault's folders here too, even with nothing downloaded in them yet: somewhere to save a new
    /// part where it belongs. Folders gone from the vault (deleted, moved, renamed) go from here once nothing
    /// is left in them; ones with files stay, so nothing of yours is lost.
    /// </summary>
    private void MirrorFolders(IEnumerable<string> vaultFolders, IEnumerable<string> before)
    {
        foreach (var path in vaultFolders)
        {
            try
            {
                Directory.CreateDirectory(ToLocalPath(path));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A file in the way, say: the folder's files still download into it once it's cleared.
            }
        }
        foreach (var path in before.Where(p => !_state.Folders.ContainsKey(VaultPaths.Key(p))).OrderByDescending(p => p.Length))
        {
            var local = ToLocalPath(path);
            try
            {
                if (Directory.Exists(local) && !Directory.EnumerateFiles(local, "*", SearchOption.AllDirectories).Any())
                {
                    Directory.Delete(local, recursive: true);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Open in Explorer, say: it goes next time.
            }
        }
    }

    /// <summary>
    /// Move copies here to where their files are in the vault now (moved or renamed, in the web app), and
    /// tidy away folders that leaves empty, unless they're still folders in the vault. A copy that can't move
    /// yet (open in SolidWorks) stays where it is until a later refresh; meanwhile it still counts as that
    /// file (see Compute).
    /// </summary>
    private void FollowMoves()
    {
        foreach (var pair in _state.Local)
        {
            if (!_state.Remote.TryGetValue(pair.Key, out var remote) || remote.Path == pair.Value.Path)
            {
                continue;
            }
            var from = ToLocalPath(pair.Value.Path);
            var to = ToLocalPath(remote.Path);
            var justTheCase = string.Equals(from, to, StringComparison.OrdinalIgnoreCase);
            if (!File.Exists(from) || (!justTheCase && File.Exists(to)))
            {
                if (!File.Exists(from) && File.Exists(to))
                {
                    pair.Value.Path = remote.Path; // moved here already, by hand
                }
                continue; // otherwise gone, or something's in the way: the status says which
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                File.Move(from, to);
                pair.Value.Path = remote.Path;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                if (!justTheCase)
                {
                    UndoHalfMove(from, to);
                }
                continue; // open somewhere: next time
            }
            for (var folder = Path.GetDirectoryName(from); folder != null && IsEmptyFolderUnderRoot(folder); folder = Path.GetDirectoryName(folder))
            {
                try
                {
                    Directory.Delete(folder);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    break;
                }
            }
        }
    }

    /// <summary>
    /// On Linux and macOS, File.Move puts the file in its new place before taking it out of the old one, so a
    /// move that fails there (the old folder can't change) leaves it in both, and the one left behind would
    /// look like a new file. Take the new one away again, so the copy stays where it was until a later
    /// refresh, as on Windows. Only a file with the same contents goes, so nothing can be lost, even if
    /// something else put a file there meanwhile. Not for a move that only changes case: that's one file.
    /// </summary>
    private static void UndoHalfMove(string from, string to)
    {
        try
        {
            if (File.Exists(from) && File.Exists(to) && new FileInfo(from).Length == new FileInfo(to).Length
                && Hashing.Sha256File(from) == Hashing.Sha256File(to))
            {
                File.Delete(to);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Left as it is: the status shows both, and nothing is lost.
        }
    }

    private bool IsEmptyFolderUnderRoot(string folder) =>
        folder.Length > Root.TrimEnd(Path.DirectorySeparatorChar).Length && Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any()
        && !_state.Folders.ContainsKey(VaultPaths.Key(ToVaultPath(folder)));

    /// <summary>The state of every file under the given local paths (default: the whole workspace).</summary>
    public async Task<IReadOnlyList<FileStatus>> StatusAsync(IEnumerable<string>? localPaths = null, CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var statuses = Compute(Scope(localPaths));
        SaveState();
        return statuses;
    }

    /// <summary>
    /// Everything, for browsing: the vault's folders and this workspace's, each file's status, and what
    /// each file uses and where it's used (see <see cref="VaultTree"/>).
    /// </summary>
    public async Task<VaultTree> BrowseAsync(CancellationToken ct = default)
    {
        var statuses = await StatusAsync(null, ct).ConfigureAwait(false);
        var uses = _state.Remote.ToDictionary(pair => pair.Key, pair => (IReadOnlyList<UsedFile>?)pair.Value.Uses);
        return new VaultTree(statuses, _state.Folders.Values.Select(f => f.Path), uses);
    }

    /// <summary>
    /// The vault files meant by paths SolidWorks files keep for the files they use (their local paths here, whether
    /// they're here yet or not), and the kept paths that mean none, as of the last refresh. A path in this workspace
    /// means the file there. A file brought from elsewhere keeps elsewhere's paths: one from Kenesto names its drive
    /// (K:\Yellow Jacket Space Program\Project CAD\09_Hopper\Stringer.SLDPRT), meaning the vault file whose path ends
    /// the same way, with the most folders matching (09_Hopper/Stringer.SLDPRT). Where others match as well, it
    /// means none of them.
    /// </summary>
    public (IReadOnlyList<string> InVault, IReadOnlyList<string> NotInVault) FindUsedFiles(IEnumerable<string> keptPaths)
    {
        var (byKey, byName) = Index(_state.Remote.Values.Select(file => file.Path));
        var inVault = new List<string>();
        var notInVault = new List<string>();
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kept in keptPaths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var here = UnderRoot(kept);
            var vaultPath = here == null
                ? VaultFileMeant(kept, byKey, byName)
                : byKey.TryGetValue(VaultPaths.Key(here), out var found) ? found : null;
            if (vaultPath != null || (here != null && File.Exists(kept))) // or new here, not checked in yet
            {
                var local = vaultPath == null ? kept : ToLocalPath(vaultPath);
                if (listed.Add(local))
                {
                    inVault.Add(local);
                }
            }
            else
            {
                notInVault.Add(kept);
            }
        }
        return (inVault, notInVault);
    }

    /// <summary>
    /// The file here that a path kept in a SolidWorks file from elsewhere means, for SolidWorks when it can't find it:
    /// the vault file it means, as <see cref="FindUsedFiles"/> finds it among vaultPaths (the vault's files), if that's
    /// here (C:\VLT\09_Hopper\Stringer.SLDPRT for K:\Yellow Jacket Space Program\Project CAD\09_Hopper\Stringer.SLDPRT);
    /// else the file here at the longest end of the path (one not checked in yet). Null if there's neither, and for
    /// paths in this workspace: they mean themselves. It reads no workspace state, so it's safe while one is running.
    /// </summary>
    public string? LocalFileFor(string keptPath, IEnumerable<string> vaultPaths)
    {
        if (UnderRoot(keptPath) != null)
        {
            return null;
        }
        var (byKey, byName) = Index(vaultPaths);
        if (VaultFileMeant(keptPath, byKey, byName) is { } vaultPath && File.Exists(ToLocalPath(vaultPath)))
        {
            return ToLocalPath(vaultPath);
        }
        var names = NamesIn(keptPath);
        for (var skip = 0; skip < names.Length; skip++)
        {
            var end = names.Skip(skip).ToList();
            if (end.All(IsVaultName))
            {
                var candidate = ToLocalPath(string.Join("/", end));
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }
        return null;
    }

    // Vault file paths by key, and those keys by their file name's key: for VaultFileMeant.
    private static (Dictionary<string, string> ByKey, ILookup<string, string> ByName) Index(IEnumerable<string> vaultPaths)
    {
        var byKey = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var path in vaultPaths)
        {
            byKey[VaultPaths.Key(path)] = path;
        }
        return (byKey, byKey.Keys.ToLookup(key => key.Substring(key.LastIndexOf('/') + 1), StringComparer.Ordinal));
    }

    // See FindUsedFiles. byKey: the vault's file paths by key; byName: those keys by their file name's.
    private static string? VaultFileMeant(string kept, Dictionary<string, string> byKey, ILookup<string, string> byName)
    {
        var names = NamesIn(kept).Select(VaultPaths.Key).ToArray();
        if (names.Length == 0)
        {
            return null;
        }
        string? best = null;
        var bestScore = -1;
        var tied = false;
        foreach (var key in byName[names[names.Length - 1]])
        {
            var parts = key.Split('/');
            var matched = 0;
            while (matched < parts.Length && matched < names.Length
                && parts[parts.Length - 1 - matched] == names[names.Length - 1 - matched])
            {
                matched++;
            }
            // A vault path that's all of the end of the kept one (the vault's top standing for a folder there) beats
            // one matching as many names with folders above them that don't.
            var score = (2 * matched) + (matched == parts.Length ? 1 : 0);
            if (score > bestScore)
            {
                (best, bestScore, tied) = (key, score, false);
            }
            else if (score == bestScore)
            {
                tied = true;
            }
        }
        return best == null || tied ? null : byKey[best];
    }

    private static string[] NamesIn(string path) => path.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);

    private static bool IsVaultName(string name)
    {
        try
        {
            VaultPaths.CleanName(name);
            return true;
        }
        catch (VaultPathException)
        {
            return false;
        }
    }

    // The path's vault path if it's in this workspace, else null.
    private string? UnderRoot(string path)
    {
        var root = Root.TrimEnd('\\', '/');
        return path.Length > root.Length + 1 && path.StartsWith(root, StringComparison.OrdinalIgnoreCase) && path[root.Length] is '\\' or '/'
            ? path.Substring(root.Length + 1).Replace('\\', '/')
            : null;
    }

    /// <summary>
    /// Check that a new file can be made at this path before making it: nothing is there, in the vault or
    /// here, and you can add files to its folder, as far as this workspace knows (the server has the last word).
    /// </summary>
    public async Task CheckNewFileAsync(string localPath, CancellationToken ct = default)
    {
        var vaultPath = string.Join("/", VaultPaths.Split(RelativePath(localPath)));
        await RefreshAsync(ct).ConfigureAwait(false);
        var key = VaultPaths.Key(vaultPath);
        if (_state.Remote.Values.Any(r => VaultPaths.Key(r.Path) == key))
        {
            throw new WorkspaceException($"{vaultPath} is already in the vault");
        }
        if (File.Exists(localPath))
        {
            throw new WorkspaceException($"{localPath} is already here, not checked in yet. Open it, or choose another name.");
        }
        if (Directory.Exists(localPath) || _state.Folders.ContainsKey(key))
        {
            throw new WorkspaceException($"{vaultPath} is a folder");
        }
        var folder = vaultPath.Contains("/") ? vaultPath.Substring(0, vaultPath.LastIndexOf('/')) : "";
        var (known, role) = RoleNear(folder);
        if (known && role is null or "viewer")
        {
            throw new WorkspaceException(
                $"You can't add files to {(folder.Length > 0 ? folder : "the top of the vault")}: that takes editor access. Ask a lead of that folder.");
        }
    }

    public async Task<FileDetail> HistoryAsync(string localPath, CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var key = VaultPaths.Key(ToVaultPath(localPath));
        foreach (var pair in _state.Remote)
        {
            if (VaultPaths.Key(pair.Value.Path) == key)
            {
                return await Api.FileAsync(pair.Key, ct).ConfigureAwait(false);
            }
        }
        throw new WorkspaceException($"{localPath} isn't in the vault");
    }

    public async Task<Account> WhoAmIAsync(CancellationToken ct = default) =>
        _me ??= await Api.MeAsync(ct).ConfigureAwait(false);

    // --- changing files ---------------------------------------------------------------------

    /// <summary>
    /// Download the latest versions of files under the given paths (default: everything you can see),
    /// including files not here yet. Named files bring the files they reference along. Files changed
    /// locally are skipped unless force is set, in which case they're backed up first. To update only
    /// what's here, see UpdateAsync.
    /// </summary>
    public async Task<GetResult> GetLatestAsync(IEnumerable<string>? localPaths = null, bool force = false, CancellationToken ct = default) =>
        await GetAsync(await PlanGetAsync(localPaths, ct).ConfigureAwait(false), force, ct).ConfigureAwait(false);

    /// <summary>
    /// Update the files that are here, under the given paths (default: the whole workspace), to their
    /// latest versions, and get the files they use that aren't here (a part an assembly started using),
    /// so they still open. Nothing else comes down: the rest of the vault stays there. Files deleted in
    /// the vault go from here, and local changes are kept (unless force), as with GetLatestAsync.
    /// </summary>
    public async Task<GetResult> UpdateAsync(IEnumerable<string>? localPaths = null, bool force = false, CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var statuses = Compute(Scope(localPaths)).Where(s => s.State != FileState.Missing).ToList();
        var here = statuses.Where(s => s.FileId != null && s.State != FileState.DeletedInVault).Select(s => s.FileId!.Value);
        var listed = new HashSet<string>(statuses.Select(s => VaultPaths.Key(s.VaultPath)), StringComparer.Ordinal);
        var used = (await ReferencedFilesAsync(here, ct).ConfigureAwait(false))
            .Where(id => _state.Remote.ContainsKey(id))
            .Select(id => VaultPaths.Key(_state.Remote[id].Path))
            .Where(key => !listed.Contains(key))
            .ToList();
        if (used.Count > 0)
        {
            statuses.AddRange(Compute(used));
        }
        return await GetAsync(statuses, force, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// What GetLatestAsync would download for these paths (default: everything you can see): files not
    /// here yet, and newer versions of the ones that are. To ask before a big download.
    /// </summary>
    public async Task<DownloadSize> SizeOfGetAsync(IEnumerable<string>? localPaths = null, CancellationToken ct = default)
    {
        var size = new DownloadSize();
        foreach (var status in await PlanGetAsync(localPaths, ct).ConfigureAwait(false))
        {
            if (status.State is FileState.Missing or FileState.Outdated)
            {
                size.Add(status.State == FileState.Missing, _state.Remote[status.FileId!.Value].Size);
            }
        }
        return size;
    }

    /// <summary>What freeing up space under these paths would remove: how many files, and the space they take.</summary>
    public async Task<(int Files, long Bytes)> SizeOfFreeUpAsync(
        IEnumerable<string>? localPaths = null, Func<string, bool>? inUse = null, CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var freeable = Freeable(Scope(localPaths), inUse);
        return (freeable.Count, freeable.Sum(s => _state.Local[s.FileId!.Value].Size));
    }

    /// <summary>
    /// Free up space: remove the copies here of the files under these paths (default: the whole workspace) that are
    /// just as they came from the vault, at any version, and not checked out to you, so nothing is lost. They stay in the
    /// vault and show as not downloaded: opening or getting them downloads them again, and updating what's here leaves
    /// them be. Files changed here, new files, files checked out to you, and the files inUse says are open stay, and so
    /// does any copy that can't be removed (open in SolidWorks, say), with why in Failures.
    /// </summary>
    public async Task<FreeUpResult> FreeUpAsync(IEnumerable<string>? localPaths = null, Func<string, bool>? inUse = null, CancellationToken ct = default)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var result = new FreeUpResult();
        try
        {
            foreach (var status in Freeable(Scope(localPaths), inUse))
            {
                var id = status.FileId!.Value;
                try
                {
                    SetReadOnly(status.LocalPath, false);
                    File.Delete(status.LocalPath);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    result.Failures.Add($"{status.VaultPath}: {e.Message}");
                    StayReadOnly(status.LocalPath);
                    continue;
                }
                result.Bytes += _state.Local[id].Size;
                _state.Local.Remove(id);
                result.Removed.Add(status);
            }
        }
        finally
        {
            SaveState();
        }
        return result;
    }

    // A copy that stays isn't checked out to you, so it's read-only again, as far as it can be.
    private static void StayReadOnly(string path)
    {
        try
        {
            SetReadOnly(path, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Left writable: the next get puts it right.
        }
    }

    // Copies here that are as they came from the vault, at any version, and not checked out to you here: removing them
    // loses nothing.
    private List<FileStatus> Freeable(List<string> scope, Func<string, bool>? inUse) =>
        Compute(scope)
            .Where(s => s.FileId is { } id
                && (s.State is FileState.UpToDate or FileState.Outdated)
                && !s.CheckedOutByMe
                && _state.Local.ContainsKey(id)
                && inUse?.Invoke(s.LocalPath) != true)
            .ToList();

    // What getting these paths involves: the files under them, and the files the ones named use.
    private async Task<List<FileStatus>> PlanGetAsync(IEnumerable<string>? localPaths, CancellationToken ct)
    {
        await RefreshAsync(ct).ConfigureAwait(false);
        var scope = Scope(localPaths);
        var statuses = Compute(scope);
        var named = statuses.Where(s => s.FileId != null && scope.Contains(VaultPaths.Key(s.VaultPath))).Select(s => s.FileId!.Value);
        var references = (await ReferencedFilesAsync(named, ct).ConfigureAwait(false))
            .Where(id => _state.Remote.ContainsKey(id))
            .Select(id => VaultPaths.Key(_state.Remote[id].Path))
            .Where(key => !InScope(key, scope))
            .ToList();
        if (references.Count > 0)
        {
            statuses.AddRange(Compute(references));
        }
        return statuses;
    }

    // Bring these files up to date: download what's missing or outdated, remove what was deleted in the vault.
    private async Task<GetResult> GetAsync(List<FileStatus> statuses, bool force, CancellationToken ct)
    {
        var result = new GetResult();
        foreach (var status in statuses)
        {
            switch (status.State)
            {
                case FileState.Missing:
                case FileState.Outdated:
                    if (await TryDownloadAsync(status, result, ct).ConfigureAwait(false))
                    {
                        result.Downloaded.Add(status);
                    }
                    break;
                case FileState.UpToDate:
                    SetReadOnly(status.LocalPath, !status.CheckedOutByMe);
                    break;
                case FileState.Modified:
                case FileState.Conflict:
                    if (!force)
                    {
                        result.Skipped.Add(status);
                        break;
                    }
                    result.BackedUp.Add(Backup(status));
                    if (await TryDownloadAsync(status, result, ct).ConfigureAwait(false))
                    {
                        result.Downloaded.Add(status);
                    }
                    break;
                case FileState.DeletedInVault:
                    var changed = IsModified(status.LocalPath, _state.Local[status.FileId!.Value]);
                    if (changed && !force)
                    {
                        result.Skipped.Add(status);
                        break;
                    }
                    if (changed)
                    {
                        result.BackedUp.Add(Backup(status));
                    }
                    SetReadOnly(status.LocalPath, false);
                    File.Delete(status.LocalPath);
                    _state.Local.Remove(status.FileId.Value);
                    result.Removed.Add(status);
                    break;
                case FileState.New:
                default:
                    break;
            }
        }
        SaveState();
        return result;
    }

    /// <summary>
    /// Whether you can take over this file's check-out (checkout with force): your own on another
    /// computer, or someone else's if you're a lead or admin there. The server has the last word.
    /// </summary>
    public bool CanTakeOver(FileStatus status) =>
        status.Lock is { } other && !status.CheckedOutByMe
        && (other.User.Id == _me?.Id || status.MyRole is "lead" or "admin");

    /// <summary>
    /// Check files out to edit them: all or nothing. Out-of-date copies are updated first. With
    /// force, check-outs elsewhere are taken over (see CanTakeOver): the other check-out ends, and
    /// changes on that computer stay there.
    /// </summary>
    public async Task<IReadOnlyList<FileStatus>> CheckoutAsync(IEnumerable<string> localPaths, bool force = false, CancellationToken ct = default)
    {
        var scope = Scope(RequirePaths(localPaths, "check out"));
        await RefreshAsync(ct).ConfigureAwait(false);
        var all = Compute(scope);
        var named = all.Where(s => (s.State is FileState.New or FileState.DeletedInVault) && scope.Contains(VaultPaths.Key(s.VaultPath))).ToList();
        if (named.Count > 0)
        {
            throw new WorkspaceException($"{named[0].VaultPath} isn't in the vault; check it in to add it");
        }
        var targets = all.Where(s => s.FileId != null && s.State != FileState.DeletedInVault).ToList();
        if (targets.Count == 0)
        {
            throw new WorkspaceException("Nothing to check out there");
        }
        var conflicts = targets.Where(s => s.State == FileState.Conflict).Select(s => s.VaultPath).ToList();
        if (conflicts.Count > 0)
        {
            throw new WorkspaceException(
                "Changed here, but someone checked in a newer version since: " + string.Join(", ", conflicts)
                + ". Keep your copy (it's checked out to you, to check in on top), or use the vault's version (yours is backed up).");
        }

        var locked = await Api.CheckoutAsync(targets.Select(s => s.VaultPath), Host, force, ct).ConfigureAwait(false);
        foreach (var file in locked)
        {
            _state.Remote[file.Id] = RemoteEntry.From(file);
        }
        foreach (var status in targets)
        {
            status.Lock = _state.Remote[status.FileId!.Value].Lock;
            status.CheckedOutByMe = true;
            if (status.State is FileState.Missing or FileState.Outdated)
            {
                await DownloadAsync(status, ct).ConfigureAwait(false);
            }
            else
            {
                SetReadOnly(status.LocalPath, false);
            }
        }
        SaveState();
        return targets;
    }

    /// <summary>
    /// Settle conflicts (changed here, and a newer version in the vault since) by keeping the copies here: the files are
    /// checked out, and each copy counts as your change to the latest version, so checking it in makes the next version.
    /// The latest stays in the history. Nothing here is downloaded or changed. All or nothing, as checking out is.
    /// </summary>
    public async Task<IReadOnlyList<FileStatus>> KeepMineAsync(IEnumerable<string> localPaths, CancellationToken ct = default)
    {
        var targets = await ConflictsAsync(localPaths, "keep", ct).ConfigureAwait(false);
        var locked = await Api.CheckoutAsync(targets.Select(s => s.VaultPath), Host, force: false, ct).ConfigureAwait(false);
        foreach (var file in locked)
        {
            _state.Remote[file.Id] = RemoteEntry.From(file);
        }
        foreach (var status in targets)
        {
            var remote = _state.Remote[status.FileId!.Value];
            // Came from the latest version, as far as the workspace knows: the copy differs from it, so it's a change.
            _state.Local[status.FileId.Value] = new LocalEntry { Path = remote.Path, Version = remote.Version, Sha256 = remote.Sha256, Size = remote.Size };
            status.Lock = remote.Lock;
            status.CheckedOutByMe = true;
            status.LocalVersion = remote.Version;
            status.State = FileState.Modified;
            SetReadOnly(status.LocalPath, false);
        }
        SaveState();
        return targets;
    }

    /// <summary>
    /// Settle conflicts by taking the vault's latest version: each copy here is backed up (BackedUp), then replaced. Only
    /// the files in conflict change; the files they use stay as they are.
    /// </summary>
    public async Task<GetResult> UseVaultVersionAsync(IEnumerable<string> localPaths, CancellationToken ct = default) =>
        await GetAsync(await ConflictsAsync(localPaths, "replace", ct).ConfigureAwait(false), force: true, ct).ConfigureAwait(false);

    // The files in conflict under these paths. A file named that isn't in conflict is a mistake: say so, rather than
    // check it out or replace it.
    private async Task<List<FileStatus>> ConflictsAsync(IEnumerable<string> localPaths, string action, CancellationToken ct)
    {
        var scope = Scope(RequirePaths(localPaths, action));
        await RefreshAsync(ct).ConfigureAwait(false);
        var all = Compute(scope);
        var settled = all.FirstOrDefault(s => s.State != FileState.Conflict && scope.Contains(VaultPaths.Key(s.VaultPath)));
        if (settled != null)
        {
            throw new WorkspaceException($"{settled.VaultPath} isn't in conflict: {Describe(settled.State)}");
        }
        var conflicts = all.Where(s => s.State == FileState.Conflict).ToList();
        return conflicts.Count > 0 ? conflicts : throw new WorkspaceException("Nothing there is in conflict");
    }

    private static string Describe(FileState state) => state switch
    {
        FileState.UpToDate => "it's up to date",
        FileState.Outdated => "it's unchanged here, and getting the latest version updates it",
        FileState.Modified => "it changed here, and nothing newer is in the vault",
        FileState.Missing => "it isn't on this computer",
        FileState.New => "it isn't in the vault yet",
        FileState.DeletedInVault => "it was deleted in the vault",
        _ => "it's " + state,
    };

    /// <summary>
    /// Check in new files and your checked-out files under the given paths, as one check-in.
    /// Files stay read-only afterwards unless keepCheckedOut is set.
    /// </summary>
    /// <param name="referencesOf">
    /// The local paths of the files a file uses (from SolidWorks: an assembly's components, a
    /// drawing's models). When given, referenced files that are new, or checked out to you with
    /// changes, join the check-in, and every reference is recorded with the version used.
    /// </param>
    /// <param name="withChangedReferences">
    /// False: referenced files checked out to you with changes stay out of the check-in (new ones still
    /// join), pinned to their version in the vault. For a new drawing of a part you're changing.
    /// </param>
    public async Task<CheckinResult> CheckinAsync(
        IEnumerable<string> localPaths,
        string comment,
        bool keepCheckedOut = false,
        Func<string, IEnumerable<string>>? referencesOf = null,
        bool withChangedReferences = true,
        CancellationToken ct = default)
    {
        var scope = Scope(RequirePaths(localPaths, "check in"));
        await RefreshAsync(ct).ConfigureAwait(false);
        var items = new List<FileStatus>();
        foreach (var status in Compute(scope))
        {
            var named = scope.Contains(VaultPaths.Key(status.VaultPath));
            if (status.State == FileState.New || (status.CheckedOutByMe && status.State != FileState.Missing))
            {
                if (status.State == FileState.Conflict)
                {
                    throw new WorkspaceException(
                        $"{status.VaultPath} changed here, but someone checked in a newer version since. Keep your copy to check it in on top.");
                }
                items.Add(status);
            }
            else if (named)
            {
                throw new WorkspaceException(status switch
                {
                    { State: FileState.Missing } => $"{status.VaultPath} isn't in this workspace; get it first",
                    { State: FileState.DeletedInVault } => $"{status.VaultPath} was deleted in the vault",
                    { Lock: { } mine } when mine.User.Id == _me?.Id => $"{status.VaultPath} is checked out to you on {mine.Host}, not this computer",
                    _ => await NotYoursAsync(status, ct).ConfigureAwait(false),
                });
            }
        }
        if (items.Count == 0)
        {
            throw new WorkspaceException("Nothing to check in: no new files, and nothing checked out to you on this computer");
        }
        var references = referencesOf is null
            ? new Dictionary<string, List<CheckinReference>>()
            : CollectReferences(items, referencesOf, withChangedReferences);
        foreach (var status in items.Where(s => s.State == FileState.New))
        {
            VaultPaths.Split(status.VaultPath); // the server's name rules, before uploading anything
        }

        var request = new CheckinRequest { Comment = comment, Host = Host, KeepCheckedOut = keepCheckedOut };
        var hashed = new Dictionary<string, (LocalEntry Entry, string LocalPath)>();
        foreach (var status in items)
        {
            var info = new FileInfo(status.LocalPath);
            var entry = new LocalEntry { Size = info.Length, WriteTimeTicks = info.LastWriteTimeUtc.Ticks, Sha256 = Hashing.Sha256File(status.LocalPath) };
            hashed[VaultPaths.Key(status.VaultPath)] = (entry, status.LocalPath);
            if (!await Api.HasBlobAsync(entry.Sha256, ct).ConfigureAwait(false))
            {
                using var content = new FileStream(status.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                await Api.UploadBlobAsync(entry.Sha256, content, ct).ConfigureAwait(false);
            }
            request.Items.Add(new CheckinItem
            {
                Path = status.VaultPath,
                Sha256 = entry.Sha256,
                Size = entry.Size,
                References = references.TryGetValue(VaultPaths.Key(status.VaultPath), out var uses) ? uses : new List<CheckinReference>(),
            });
        }

        var result = await Api.CheckinAsync(request, ct).ConfigureAwait(false);
        foreach (var checkedIn in result.Files)
        {
            var file = checkedIn.File;
            _state.Remote[file.Id] = RemoteEntry.From(file);
            // Size and time as they were when hashed: if the file changed since, the next status sees it.
            var (entry, localPath) = hashed[VaultPaths.Key(file.Path)];
            entry.Path = file.Path;
            entry.Version = file.Version;
            entry.Sha256 = file.Sha256;
            _state.Local[file.Id] = entry;
            SetReadOnly(localPath, file.CheckedOut == null);
        }
        SaveState();
        return result;
    }

    /// <summary>Release your check-outs. Local changes are backed up, then replaced with the latest version.</summary>
    public async Task<UndoResult> UndoCheckoutAsync(IEnumerable<string> localPaths, CancellationToken ct = default)
    {
        var scope = Scope(RequirePaths(localPaths, "undo"));
        await RefreshAsync(ct).ConfigureAwait(false);
        var all = Compute(scope);
        var notMine = all.Where(s => !s.CheckedOutByMe && scope.Contains(VaultPaths.Key(s.VaultPath))).ToList();
        if (notMine.Count > 0)
        {
            throw new WorkspaceException($"{notMine[0].VaultPath} isn't checked out to you on this computer");
        }
        var targets = all.Where(s => s.CheckedOutByMe).ToList();
        if (targets.Count == 0)
        {
            throw new WorkspaceException("Nothing is checked out to you there");
        }

        // Put the vault's versions back before releasing the locks. If a file can't be replaced (SolidWorks
        // has it open), it's still checked out to you, so you can close it and undo again.
        var result = new UndoResult();
        foreach (var status in targets)
        {
            if (status.State is FileState.Modified or FileState.Conflict)
            {
                result.BackedUp.Add(Backup(status));
                await DownloadAsync(status, ct).ConfigureAwait(false);
            }
            else if (status.State == FileState.Outdated)
            {
                await DownloadAsync(status, ct).ConfigureAwait(false);
            }
        }
        var released = await Api.UndoCheckoutAsync(targets.Select(s => s.VaultPath), ct).ConfigureAwait(false);
        foreach (var file in released)
        {
            _state.Remote[file.Id] = RemoteEntry.From(file);
        }
        foreach (var status in targets)
        {
            status.Lock = null;
            status.CheckedOutByMe = false;
            SetReadOnly(status.LocalPath, true);
            result.Released.Add(status);
        }
        SaveState();
        return result;
    }

    // --- internals --------------------------------------------------------------------------

    private static IEnumerable<string> RequirePaths(IEnumerable<string> localPaths, string action)
    {
        var list = localPaths.ToList();
        if (list.Count == 0)
        {
            throw new WorkspaceException($"Say which files or folders to {action}");
        }
        return list;
    }

    /// <summary>
    /// Each item's references as vault paths. Referenced files that are new, or checked out to
    /// you with changes (unless withChanged is false), are added to items (and their own references
    /// followed); the rest are pinned to the version this workspace has, which is the one the item
    /// was built against. Referenced files the vault can't have are all named in one exception.
    /// </summary>
    private Dictionary<string, List<CheckinReference>> CollectReferences(
        List<FileStatus> items, Func<string, IEnumerable<string>> referencesOf, bool withChanged)
    {
        var everything = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
        foreach (var status in Compute(new List<string> { "" }))
        {
            everything[VaultPaths.Key(status.VaultPath)] = status;
        }
        var included = new HashSet<string>(items.Select(s => VaultPaths.Key(s.VaultPath)), StringComparer.Ordinal);
        var result = new Dictionary<string, List<CheckinReference>>(StringComparer.Ordinal);
        var queue = new Queue<FileStatus>(items);
        var missing = new List<string>(); // neither here nor in the vault, like a part left behind on Kenesto
        var outside = new List<string>(); // on this computer, but not in the workspace
        string? user = null; // the first file that uses one of those
        while (queue.Count > 0)
        {
            var item = queue.Dequeue();
            var uses = new List<CheckinReference>();
            foreach (var localPath in referencesOf(item.LocalPath).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var vaultPath = UnderRoot(localPath) == null ? null : ToVaultPath(localPath);
                var key = vaultPath == null ? null : VaultPaths.Key(vaultPath);
                FileStatus? used = null;
                if (key == null || !everything.TryGetValue(key, out used))
                {
                    (vaultPath == null && File.Exists(localPath) ? outside : missing).Add(localPath);
                    user ??= item.VaultPath;
                    continue;
                }
                if (used.State is FileState.Conflict or FileState.DeletedInVault)
                {
                    var problem = used.State == FileState.Conflict ? "changed here after someone checked in a newer version" : "was deleted in the vault";
                    throw new WorkspaceException($"{item.VaultPath} uses {vaultPath}, which {problem}");
                }
                var joins = used.State == FileState.New || (withChanged && used.CheckedOutByMe && used.State == FileState.Modified);
                if (joins && included.Add(key))
                {
                    items.Add(used);
                    queue.Enqueue(used);
                }
                uses.Add(new CheckinReference
                {
                    Path = used.VaultPath,
                    // Files in this check-in get their new version; the server fills it in.
                    Version = included.Contains(key) ? null : used.LocalVersion ?? used.RemoteVersion,
                });
            }
            result[VaultPaths.Key(item.VaultPath)] = uses;
        }
        if (user != null)
        {
            throw new WorkspaceException(CantUse(user, missing, outside));
        }
        return result;
    }

    // Why a check-in can't record what its files use: each file it can't, and what to do about it.
    private string CantUse(string user, List<string> missing, List<string> outside)
    {
        missing = missing.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        outside = outside.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var lines = new List<string> { $"{user} can't be checked in: it uses files that aren't in the vault." };
        if (missing.Count > 0)
        {
            lines.Add(missing.Count == 1
                ? "This one is missing: it isn't here or in the vault. Add it to the vault, or take it out of what uses it:"
                : $"These {missing.Count} are missing: they aren't here or in the vault. Add them to the vault, or take them out of what uses them:");
            lines.AddRange(Listed(missing));
        }
        if (outside.Count > 0)
        {
            lines.Add((outside.Count == 1 ? "This one is" : $"These {outside.Count} are")
                + $" outside the workspace: move {(outside.Count == 1 ? "it" : "them")} into {Root} (for example with Pack and Go):");
            lines.AddRange(Listed(outside));
        }
        return string.Join(Environment.NewLine, lines);
    }

    // Paths one to a line, up to 20 of them.
    private static IEnumerable<string> Listed(List<string> paths)
    {
        const int Shown = 20;
        var lines = paths.Take(Shown).Select(path => "  " + path).ToList();
        if (paths.Count > Shown)
        {
            lines.Add($"  and {paths.Count - Shown} more");
        }
        return lines;
    }

    private bool IsMine(FileLock? fileLock) =>
        fileLock != null && _me != null && fileLock.User.Id == _me.Id && fileLock.Host == Host;

    /// <summary>
    /// Why you can't check in a file that isn't checked out to you. If it was, until a lead released
    /// your check-out or took it over, say so: your changes are still here.
    /// </summary>
    private async Task<string> NotYoursAsync(FileStatus status, CancellationToken ct)
    {
        var released = await ReleasedAsync(status, ct).ConfigureAwait(false);
        if (status.Lock is { } other)
        {
            var how = released == null ? ""
                : released.By == other.User.Name ? $": {released.By} took it over from you {released.When}"
                : $". {released.By} released your check-out {released.When}";
            return $"{status.VaultPath} is checked out by {other.User.Name} on {other.Host}{how}";
        }
        return released == null
            ? $"Check out {status.VaultPath} before checking it in"
            : $"{released.By} released your check-out of {status.VaultPath} {released.When}. "
                + "Your changes are still here: check it out again, then check it in.";
    }

    private sealed class Release
    {
        public string By { get; set; } = "";
        public string When { get; set; } = "";
    }

    // The latest release of your check-out of this file (a "break_lock" with you as the holder), unless
    // you've checked it out since.
    private async Task<Release?> ReleasedAsync(FileStatus status, CancellationToken ct)
    {
        if (status.FileId is not { } id || _me == null)
        {
            return null;
        }
        List<VaultEvent> events;
        try
        {
            events = await Api.ActivityAsync(id, 50, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is VaultApiException or HttpRequestException)
        {
            return null; // only for the explanation
        }
        foreach (var e in events)
        {
            if (e.Action == "checkout" && e.User?.Id == _me.Id)
            {
                return null;
            }
            if (e.Action == "break_lock" && e.Detail.TryGetValue("holder", out var holder)
                && holder.ValueKind == JsonValueKind.String && string.Equals(holder.GetString(), _me.Email, StringComparison.OrdinalIgnoreCase))
            {
                var when = e.At.ToLocalTime().ToString("MMM d 'at' HH:mm", CultureInfo.InvariantCulture);
                return new Release { By = e.User?.Name ?? "Someone", When = "on " + when };
            }
        }
        return null;
    }

    // Your role in the folder a vault file is in. The top of the vault isn't in the sync feed.
    private string? RoleIn(string vaultPath)
    {
        var slash = vaultPath.LastIndexOf('/');
        return RoleNear(slash > 0 ? vaultPath.Substring(0, slash) : "").Role;
    }

    // Your role in a vault folder, or in the nearest one above it that exists; known is false when that's
    // the top of the vault, which isn't in the sync feed.
    private (bool Known, string? Role) RoleNear(string vaultFolder)
    {
        if (_me?.IsAdmin == true)
        {
            return (true, "admin");
        }
        for (var folder = vaultFolder; folder.Length > 0; folder = folder.Contains("/") ? folder.Substring(0, folder.LastIndexOf('/')) : "")
        {
            if (_state.Folders.TryGetValue(VaultPaths.Key(folder), out var entry))
            {
                return (true, entry.Role);
            }
        }
        return (false, null);
    }

    private List<FileStatus> Compute(List<string> scope)
    {
        var locals = LocalFiles(scope);
        var statuses = new List<FileStatus>();
        foreach (var pair in _state.Remote)
        {
            var remote = pair.Value;
            var key = VaultPaths.Key(remote.Path);
            if (!InScope(key, scope))
            {
                continue;
            }
            var status = new FileStatus
            {
                VaultPath = remote.Path,
                LocalPath = ToLocalPath(remote.Path),
                FileId = pair.Key,
                RemoteVersion = remote.Version,
                Lock = remote.Lock,
                CheckedOutByMe = IsMine(remote.Lock),
                MyRole = RoleIn(remote.Path),
            };
            var at = key;
            if (!locals.ContainsKey(at) && _state.Local.TryGetValue(pair.Key, out var had) && locals.ContainsKey(VaultPaths.Key(had.Path)))
            {
                at = VaultPaths.Key(had.Path); // moved in the vault, but the copy here couldn't follow yet (FollowMoves)
            }
            if (!locals.TryGetValue(at, out var localPath))
            {
                status.State = FileState.Missing;
            }
            else
            {
                locals.Remove(at);
                status.LocalPath = localPath;
                status.State = LocalState(pair.Key, remote, localPath, status);
            }
            statuses.Add(status);
        }

        // Copies that came from the vault, of files deleted there since.
        foreach (var pair in _state.Local)
        {
            var key = VaultPaths.Key(pair.Value.Path);
            if (!_state.Remote.ContainsKey(pair.Key) && locals.TryGetValue(key, out var localPath))
            {
                locals.Remove(key);
                statuses.Add(new FileStatus
                {
                    VaultPath = pair.Value.Path,
                    LocalPath = localPath,
                    FileId = pair.Key,
                    LocalVersion = pair.Value.Version,
                    State = FileState.DeletedInVault,
                });
            }
        }

        foreach (var pair in locals)
        {
            statuses.Add(new FileStatus { VaultPath = VaultPathOf(pair.Value), LocalPath = pair.Value, State = FileState.New });
        }
        statuses.Sort((a, b) => string.CompareOrdinal(VaultPaths.Key(a.VaultPath), VaultPaths.Key(b.VaultPath)));
        return statuses;
    }

    private FileState LocalState(long id, RemoteEntry remote, string localPath, FileStatus status)
    {
        if (!_state.Local.TryGetValue(id, out var local))
        {
            // A copy that didn't come through the vault: put there by hand, or the state was lost.
            var info = new FileInfo(localPath);
            var sha = Hashing.Sha256File(localPath);
            if (sha != remote.Sha256)
            {
                return FileState.Conflict;
            }
            _state.Local[id] = new LocalEntry { Path = remote.Path, Version = remote.Version, Sha256 = sha, Size = info.Length, WriteTimeTicks = info.LastWriteTimeUtc.Ticks };
            status.LocalVersion = remote.Version;
            return FileState.UpToDate;
        }
        status.LocalVersion = local.Version;
        var current = local.Version == remote.Version;
        if (!IsModified(localPath, local))
        {
            return current ? FileState.UpToDate : FileState.Outdated;
        }
        return current ? FileState.Modified : FileState.Conflict;
    }

    /// <summary>Whether a local copy differs from the version it came from (hashes only when size or time changed).</summary>
    private static bool IsModified(string localPath, LocalEntry local)
    {
        var info = new FileInfo(localPath);
        if (info.Length == local.Size && info.LastWriteTimeUtc.Ticks == local.WriteTimeTicks)
        {
            return false;
        }
        if (info.Length == local.Size && Hashing.Sha256File(localPath) == local.Sha256)
        {
            local.WriteTimeTicks = info.LastWriteTimeUtc.Ticks; // touched, not changed
            return false;
        }
        return true;
    }

    /// <summary>Workspace files in scope, by vault key. Skips the workspace's own folder and ignored files.</summary>
    private Dictionary<string, string> LocalFiles(List<string> scope)
    {
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        var pending = new Stack<string>();
        pending.Push(Root);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            string[] folders, files;
            try
            {
                folders = Directory.GetDirectories(dir);
                files = Directory.GetFiles(dir);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var folder in folders)
            {
                var name = Path.GetFileName(folder);
                if (!(dir == Root && name == MetaFolder) && !VaultPaths.IsIgnored(name))
                {
                    pending.Push(folder);
                }
            }
            foreach (var file in files)
            {
                if (VaultPaths.IsIgnored(Path.GetFileName(file)))
                {
                    continue;
                }
                var key = VaultPaths.Key(VaultPathOf(file));
                if (InScope(key, scope))
                {
                    found[key] = file;
                }
            }
        }
        return found;
    }

    // Unvalidated: status lists badly named files as new; check-in rejects them.
    private string VaultPathOf(string localPath) => RelativePath(localPath).Normalize(System.Text.NormalizationForm.FormC);

    private async Task<HashSet<long>> ReferencedFilesAsync(IEnumerable<long> roots, CancellationToken ct)
    {
        var seen = new HashSet<long>(roots);
        var queue = new Queue<long>(seen);
        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            if (!_state.Remote.TryGetValue(id, out var remote)
                || !MayReference.Any(ext => remote.Path.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
            {
                continue; // STEP files and the like never reference other files
            }
            var uses = remote.Uses?.Select(used => used.FileId);
            if (uses == null)
            {
                // A server older than the sync feed's uses: ask for the latest version's references.
                var detail = await Api.FileAsync(id, ct).ConfigureAwait(false);
                uses = (detail.Versions.FirstOrDefault()?.References ?? new List<VersionReference>()).Where(r => !r.Deleted).Select(r => r.FileId);
            }
            foreach (var used in uses)
            {
                if (seen.Add(used))
                {
                    queue.Enqueue(used);
                }
            }
        }
        return seen;
    }

    /// <summary>Download, or record why not (a file open in SolidWorks can't be replaced) and carry on.</summary>
    private async Task<bool> TryDownloadAsync(FileStatus status, GetResult result, CancellationToken ct)
    {
        try
        {
            await DownloadAsync(status, ct).ConfigureAwait(false);
            return true;
        }
        catch (WorkspaceException e)
        {
            result.Failures.Add(e.Message);
            return false;
        }
    }

    private async Task DownloadAsync(FileStatus status, CancellationToken ct)
    {
        var id = status.FileId!.Value;
        var remote = _state.Remote[id];
        var localPath = status.LocalPath;
        Directory.CreateDirectory(Path.GetDirectoryName(localPath)!);
        var temp = localPath + DownloadSuffix;
        try
        {
            using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await Api.DownloadAsync(id, remote.Version, file, ct).ConfigureAwait(false);
            }
            if (Hashing.Sha256File(temp) != remote.Sha256)
            {
                throw new WorkspaceException($"The download of {remote.Path} was damaged; try again");
            }
            ReplaceWith(temp, localPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new WorkspaceException($"Can't write {localPath}: {e.Message}", e);
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
        SetReadOnly(localPath, !IsMine(remote.Lock));
        var info = new FileInfo(localPath);
        _state.Local[id] = new LocalEntry
        {
            Path = remote.Path,
            Version = remote.Version,
            Sha256 = remote.Sha256,
            Size = info.Length,
            WriteTimeTicks = info.LastWriteTimeUtc.Ticks,
        };
        status.State = FileState.UpToDate;
        status.LocalVersion = remote.Version;
    }

    private static void ReplaceWith(string source, string destination)
    {
        try
        {
            if (File.Exists(destination))
            {
                SetReadOnly(destination, false);
                File.Replace(source, destination, null, ignoreMetadataErrors: true);
            }
            else
            {
                File.Move(source, destination);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new WorkspaceException($"Can't replace {destination}: {e.Message} If it's open in SolidWorks, close it and try again.", e);
        }
    }

    /// <summary>Copy a local file to .vault/backup/(time)/(vault path) before it's replaced; returns the copy's path.</summary>
    private string Backup(FileStatus status)
    {
        var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var copy = Path.Combine(Root, MetaFolder, "backup", stamp, status.VaultPath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
        File.Copy(status.LocalPath, copy, overwrite: true);
        return copy;
    }

    internal static void SetReadOnly(string path, bool readOnly)
    {
        if (!File.Exists(path))
        {
            return;
        }
        var attributes = File.GetAttributes(path);
        var updated = readOnly ? attributes | FileAttributes.ReadOnly : attributes & ~FileAttributes.ReadOnly;
        if (updated != attributes)
        {
            File.SetAttributes(path, updated);
        }
    }

    private void SaveState() => WriteJson(Path.Combine(Root, MetaFolder, StateFile), _state);

    private static T? ReadJson<T>(string path)
        where T : class =>
        File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), Json.Options) : null;

    private static void WriteJson<T>(string path, T value)
    {
        // Write then rename, so a crash never leaves half a file.
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(value, Json.Indented));
        if (File.Exists(path))
        {
            File.Replace(temp, path, null);
        }
        else
        {
            File.Move(temp, path);
        }
    }
}
