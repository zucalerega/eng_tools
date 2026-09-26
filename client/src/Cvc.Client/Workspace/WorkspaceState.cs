using System.Security.Cryptography;
using System.Text;

namespace Cvc.Client;

/// <summary>.cvc/config.json: which server this workspace belongs to.</summary>
internal sealed class WorkspaceConfig
{
    public string Server { get; set; } = "";

    /// <summary>Overrides the computer name that locks are held for (tests, shared machines).</summary>
    public string? Host { get; set; }
}

/// <summary>.cvc/state.json: what this workspace knows about the vault and its own copies.</summary>
internal sealed class WorkspaceState
{
    /// <summary>Sync cursor: the server's seq at the last refresh.</summary>
    public long Seq { get; set; }

    /// <summary>The vault's live files as of the last refresh, by file id.</summary>
    public Dictionary<long, RemoteEntry> Remote { get; set; } = new Dictionary<long, RemoteEntry>();

    /// <summary>Files this workspace downloaded or checked in, by file id.</summary>
    public Dictionary<long, LocalEntry> Local { get; set; } = new Dictionary<long, LocalEntry>();
}

internal sealed class RemoteEntry
{
    public string Path { get; set; } = "";
    public int Version { get; set; }
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public FileLock? Lock { get; set; }

    public static RemoteEntry From(VaultFile file) => new RemoteEntry
    {
        Path = file.Path,
        Version = file.Version,
        Sha256 = file.Sha256,
        Size = file.Size,
        Lock = file.CheckedOut,
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
        var hash = sha.ComputeHash(stream);
        var hex = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            hex.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }
        return hex.ToString();
    }
}
