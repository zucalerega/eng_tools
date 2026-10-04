namespace Vault.Client;

/// <summary>
/// The vault and this workspace as a tree, for browsing (the add-in's Browse tab): folders, the files in
/// each with their status, what each file uses, and where each file is used, as of one refresh. Files
/// only here (new) are in it too, in the folders they're in.
/// </summary>
public sealed class VaultTree
{
    private static readonly StringComparer Names = StringComparer.OrdinalIgnoreCase;
    private readonly Dictionary<long, FileStatus> _byId = new Dictionary<long, FileStatus>();
    private readonly Dictionary<long, IReadOnlyList<UsedFile>?> _uses;
    private readonly Dictionary<long, List<FileStatus>> _usedBy = new Dictionary<long, List<FileStatus>>();

    internal VaultTree(IReadOnlyList<FileStatus> files, IEnumerable<string> vaultFolders, Dictionary<long, IReadOnlyList<UsedFile>?> uses)
    {
        Files = files;
        _uses = uses;
        foreach (var file in files.Where(f => f.FileId != null))
        {
            _byId[file.FileId!.Value] = file;
        }
        foreach (var file in files.Where(f => f.FileId != null && f.State != FileState.DeletedInVault))
        {
            foreach (var used in UsesOf(file.FileId!.Value) ?? Array.Empty<UsedFile>())
            {
                if (!_usedBy.TryGetValue(used.FileId, out var parents))
                {
                    _usedBy[used.FileId] = parents = new List<FileStatus>();
                }
                parents.Add(file);
            }
        }
        foreach (var parents in _usedBy.Values)
        {
            parents.Sort((a, b) => Names.Compare(NameOf(a.VaultPath), NameOf(b.VaultPath)));
        }
        Root = Build(files, vaultFolders);
    }

    /// <summary>Every file, sorted by vault path: in the vault, here, or both.</summary>
    public IReadOnlyList<FileStatus> Files { get; }

    /// <summary>The top of the vault.</summary>
    public TreeFolder Root { get; }

    /// <summary>
    /// What a file's latest version in the vault uses, by name, each with the version it was checked in
    /// with; files deleted from the vault since come last, with no status. Null if the server doesn't say
    /// (servers older than this), empty for a file that isn't in the vault.
    /// </summary>
    public IReadOnlyList<UsedStatus>? Uses(FileStatus file)
    {
        if (file.FileId is not { } id)
        {
            return Array.Empty<UsedStatus>();
        }
        return UsesOf(id)?
            .Select(used => new UsedStatus(used.FileId, used.Version, _byId.TryGetValue(used.FileId, out var status) && status.State != FileState.DeletedInVault ? status : null))
            .OrderBy(used => used.File == null ? 1 : 0)
            .ThenBy(used => used.File == null ? "" : NameOf(used.File.VaultPath), Names)
            .ToList();
    }

    /// <summary>The files whose latest version uses this one (assemblies, drawings), by name.</summary>
    public IReadOnlyList<FileStatus> UsedBy(FileStatus file) =>
        file.FileId is { } id && _usedBy.TryGetValue(id, out var parents) ? parents : (IReadOnlyList<FileStatus>)Array.Empty<FileStatus>();

    /// <summary>A part's or assembly's drawings: the drawings that show it.</summary>
    public IReadOnlyList<FileStatus> Drawings(FileStatus file) => UsedBy(file).Where(f => IsDrawing(f.VaultPath)).ToList();

    public static bool IsDrawing(string path) => path.EndsWith(".slddrw", StringComparison.OrdinalIgnoreCase);

    private IReadOnlyList<UsedFile>? UsesOf(long id) => _uses.TryGetValue(id, out var uses) ? uses : null;

    private static string NameOf(string vaultPath) => vaultPath.Substring(vaultPath.LastIndexOf('/') + 1);

    private static TreeFolder Build(IReadOnlyList<FileStatus> files, IEnumerable<string> vaultFolders)
    {
        var root = new TreeFolder("", "", null);
        var folders = new Dictionary<string, TreeFolder>(StringComparer.Ordinal) { [""] = root };
        TreeFolder FolderAt(string path)
        {
            var key = VaultPaths.Key(path);
            if (folders.TryGetValue(key, out var found))
            {
                return found;
            }
            var slash = path.LastIndexOf('/');
            var parent = FolderAt(slash < 0 ? "" : path.Substring(0, slash));
            var folder = new TreeFolder(path, path.Substring(slash + 1), parent);
            parent.FolderList.Add(folder);
            folders[key] = folder;
            return folder;
        }
        foreach (var path in vaultFolders)
        {
            FolderAt(path);
        }
        foreach (var file in files)
        {
            var slash = file.VaultPath.LastIndexOf('/');
            var folder = FolderAt(slash < 0 ? "" : file.VaultPath.Substring(0, slash));
            folder.FileList.Add(file);
            if (file.Lock != null)
            {
                for (var up = folder; up != null; up = up.Parent)
                {
                    up.CheckedOut++;
                }
            }
        }
        root.Sort();
        return root;
    }
}

/// <summary>A folder in a <see cref="VaultTree"/>: its folders and files, by name.</summary>
public sealed class TreeFolder
{
    internal TreeFolder(string vaultPath, string name, TreeFolder? parent)
    {
        VaultPath = vaultPath;
        Name = name;
        Parent = parent;
    }

    /// <summary>"" for the top of the vault.</summary>
    public string VaultPath { get; }

    public string Name { get; }

    public IReadOnlyList<TreeFolder> Folders => FolderList;

    public IReadOnlyList<FileStatus> Files => FileList;

    /// <summary>How many files in it, at any depth, are checked out, by anyone.</summary>
    public int CheckedOut { get; internal set; }

    internal TreeFolder? Parent { get; }

    internal List<TreeFolder> FolderList { get; } = new List<TreeFolder>();

    internal List<FileStatus> FileList { get; } = new List<FileStatus>();

    internal void Sort()
    {
        FolderList.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
        FileList.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.VaultPath, b.VaultPath));
        foreach (var folder in FolderList)
        {
            folder.Sort();
        }
    }
}

/// <summary>A file another file uses: the version it was checked in with, and its status (null: deleted from the vault since).</summary>
public sealed class UsedStatus
{
    internal UsedStatus(long fileId, int version, FileStatus? file)
    {
        FileId = fileId;
        Version = version;
        File = file;
    }

    public long FileId { get; }

    public int Version { get; }

    public FileStatus? File { get; }
}
