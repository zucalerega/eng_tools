using System.Security.Cryptography;
using System.Text;

namespace Vault.Client;

/// <summary>.vault/config.json: which server this workspace belongs to.</summary>
internal sealed class WorkspaceConfig
{
    public string Server { get; set; } = "";

    /// <summary>Overrides the computer name that locks are held for (tests, shared machines).</summary>
    public string? Host { get; set; }
}

/// <summary>.vault/state.json: what this workspace knows about the vault and its own copies.</summary>
internal sealed class WorkspaceState
{
    /// <summary>
    /// What a workspace keeps from the sync feed now. One kept less (an older client's) syncs everything again.
    /// 2: the vault's folders are made here too, which that first full sync does for all of them.
    /// </summary>
    public const int CurrentSyncFormat = 2;

    /// <summary>Sync cursor: the server's seq at the last refresh.</summary>
    public long Seq { get; set; }

    /// <summary>The shape of Remote and Folders; below CurrentSyncFormat, the next refresh gets everything.</summary>
    public int SyncFormat { get; set; }

    /// <summary>The vault's live files as of the last refresh, by file id.</summary>
    public Dictionary<long, RemoteEntry> Remote { get; set; } = new Dictionary<long, RemoteEntry>();

    /// <summary>Files this workspace downloaded or checked in, by file id.</summary>
    public Dictionary<long, LocalEntry> Local { get; set; } = new Dictionary<long, LocalEntry>();

    /// <summary>The vault folders you can see, by path key, with your role in each.</summary>
    public Dictionary<string, FolderEntry> Folders { get; set; } = new Dictionary<string, FolderEntry>(StringComparer.Ordinal);
}

internal sealed class FolderEntry
{
    public string Path { get; set; } = "";

    /// <summary>viewer, editor, lead, admin, or null (you can only pass through).</summary>
    public string? Role { get; set; }
}

internal sealed class RemoteEntry
{
    public string Path { get; set; } = "";
    public int Version { get; set; }
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public FileLock? Lock { get; set; }

    /// <summary>What the latest version uses; null if the server didn't say (older servers).</summary>
    public List<UsedFile>? Uses { get; set; }

    public static RemoteEntry From(VaultFile file) => new RemoteEntry
    {
        Path = file.Path,
        Version = file.Version,
        Sha256 = file.Sha256,
        Size = file.Size,
        Lock = file.CheckedOut,
        Uses = file.Uses,
    };
}

/// <summary>A local copy: which version it is, and its hash, size and write time when last hashed.</summary>
internal sealed class LocalEntry
{
    public string Path { get; set; } = "";
    public int Version { get; set; }
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public long WriteTimeTicks { get; set; }
}

internal static class Hashing
{
    public static string Sha256File(string path)
    {
        // Share read/write: SolidWorks keeps files open while you work on them.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        using var sha = SHA256.Create();
        return Hex(sha.ComputeHash(stream));
    }

    public static string Sha256(byte[] data)
    {
        using var sha = SHA256.Create();
        return Hex(sha.ComputeHash(data));
    }

    private static string Hex(byte[] hash)
    {
        var hex = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            hex.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }
        return hex.ToString();
    }
}
