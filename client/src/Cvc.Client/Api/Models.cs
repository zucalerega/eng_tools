namespace Cvc.Client;

// Bodies of the server's JSON API (server/src/yjsp_server/api/schemas.py). Property names map
// to the server's snake_case names through Json.Options.

/// <summary>A person, as shown next to files and versions.</summary>
public sealed class UserRef
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
}

/// <summary>The signed-in account.</summary>
public sealed class Account
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string Status { get; set; } = "";
    public bool IsAdmin { get; set; }
}

/// <summary>Who has a file checked out, on which computer, since when.</summary>
public sealed class FileLock
{
    public UserRef User { get; set; } = new UserRef();
    public string Host { get; set; } = "";
    public DateTimeOffset Since { get; set; }
}

/// <summary>A file that another file's latest version uses (an assembly's part), and the version it was checked in with.</summary>
public sealed class UsedFile
{
    public long FileId { get; set; }
    public int Version { get; set; }
}

public sealed class VaultFile
{
    public long Id { get; set; }
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public long FolderId { get; set; }
    public int Version { get; set; }
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
    public DateTimeOffset ModifiedAt { get; set; }
    public UserRef ModifiedBy { get; set; } = new UserRef();
    public FileLock? CheckedOut { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>What the latest version uses: files you can see, maybe deleted since. Null from servers older than this.</summary>
    public List<UsedFile>? Uses { get; set; }
}

public sealed class VaultFolder
{
    public long Id { get; set; }
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Role { get; set; }
}

public sealed class FolderListing
{
    public VaultFolder Folder { get; set; } = new VaultFolder();
    public List<VaultFolder> Folders { get; set; } = new List<VaultFolder>();
    public List<VaultFile> Files { get; set; } = new List<VaultFile>();
}

/// <summary>A file a version uses (an assembly's part), pinned to the version it used.</summary>
public sealed class VersionReference
{
    public long FileId { get; set; }
    public string Path { get; set; } = "";
    public int Version { get; set; }
    public bool Deleted { get; set; }
}

public sealed class FileVersion
{
    public int Number { get; set; }
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public UserRef Author { get; set; } = new UserRef();
    public string Comment { get; set; } = "";
    public string Host { get; set; } = "";
    public long CheckinId { get; set; }
    public List<VersionReference> References { get; set; } = new List<VersionReference>();
}

public sealed class FileUse
{
    public VaultFile File { get; set; } = new VaultFile();
    public int UsesVersion { get; set; }
}

public sealed class FileDetail
{
    public VaultFile File { get; set; } = new VaultFile();

    /// <summary>Newest first.</summary>
    public List<FileVersion> Versions { get; set; } = new List<FileVersion>();

    /// <summary>Live files whose latest version uses this one.</summary>
    public List<FileUse> UsedBy { get; set; } = new List<FileUse>();
}

public sealed class CheckinReference
{
    public string Path { get; set; } = "";
    public int? Version { get; set; }
}

public sealed class CheckinItem
{
    public string Path { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public List<CheckinReference> References { get; set; } = new List<CheckinReference>();
}

public sealed class CheckinRequest
{
    public string Comment { get; set; } = "";
    public string Host { get; set; } = "";
    public bool KeepCheckedOut { get; set; }
    public List<CheckinItem> Items { get; set; } = new List<CheckinItem>();
}

public sealed class CheckedInFile
{
    /// <summary>"created", "updated", or "unchanged".</summary>
    public string Status { get; set; } = "";
    public VaultFile File { get; set; } = new VaultFile();
}

public sealed class CheckinResult
{
    /// <summary>Null when nothing changed.</summary>
    public long? CheckinId { get; set; }
    public List<CheckedInFile> Files { get; set; } = new List<CheckedInFile>();
}

/// <summary>What a move or rename moved, where it is now.</summary>
public sealed class Moved
{
    public List<VaultFolder> Folders { get; set; } = new List<VaultFolder>();
    public List<VaultFile> Files { get; set; } = new List<VaultFile>();
}

public sealed class SyncResult
{
    public long Seq { get; set; }

    /// <summary>True: this is everything the user can see. False: only changes, including deleted files.</summary>
    public bool Full { get; set; }
    public List<VaultFolder> Folders { get; set; } = new List<VaultFolder>();
    public List<VaultFile> Files { get; set; } = new List<VaultFile>();
}

/// <summary>An entry in the activity log (GET /api/activity), newest first.</summary>
public sealed class VaultEvent
{
    public long Id { get; set; }
    public DateTimeOffset At { get; set; }

    /// <summary>"checkin", "checkout", "break_lock", ... (see the server's vault/vault.py).</summary>
    public string Action { get; set; } = "";
    public UserRef? User { get; set; }
    public long? FileId { get; set; }
    public Dictionary<string, System.Text.Json.JsonElement> Detail { get; set; } = new Dictionary<string, System.Text.Json.JsonElement>();
    public string? Comment { get; set; }
}

public sealed class IssuedToken
{
    public string Token { get; set; } = "";
    public Account User { get; set; } = new Account();
}

internal sealed class FileList
{
    public List<VaultFile> Files { get; set; } = new List<VaultFile>();
}
