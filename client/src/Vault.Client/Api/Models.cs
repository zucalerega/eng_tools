namespace Vault.Client;

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

    /// <summary>What people call it: its name without its type, until someone names it. Null from servers before titles.</summary>
    public string? Title { get; set; }

    /// <summary>A vendor's part (a McMaster screw), which keeps the vendor's name rather than taking a part number.</summary>
    public bool Vendor { get; set; }

    /// <summary>
    /// The names it had before its renames, oldest first: SolidWorks files saved before then still look for it by them.
    /// Null from servers before titles.
    /// </summary>
    public List<string>? FormerNames { get; set; }
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

    /// <summary>The file by id rather than path, which a rename in the same check-in doesn't change (servers from part numbers on).</summary>
    public long? FileId { get; set; }

    public int? Version { get; set; }
}

public sealed class CheckinItem
{
    public string Path { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public List<CheckinReference> References { get; set; } = new List<CheckinReference>();

    /// <summary>What it's called; a new file's is otherwise its part number's, or its name's (servers from part numbers on).</summary>
    public string? Title { get; set; }

    /// <summary>A vendor's part, which keeps its vendor's name; a new file's is otherwise as its name says (a McMaster number).</summary>
    public bool? Vendor { get; set; }

    /// <summary>The version its changes start from: refused (out_of_date) if the file is past it.</summary>
    public int? BaseVersion { get; set; }
}

/// <summary>A file renamed in a check-in: checked out to you on this computer, and an item too, by its new path.</summary>
public sealed class CheckinRename
{
    public long File { get; set; }

    /// <summary>Its new name, in its folder.</summary>
    public string Name { get; set; } = "";
}

public sealed class CheckinRequest
{
    public string Comment { get; set; } = "";
    public string Host { get; set; } = "";
    public bool KeepCheckedOut { get; set; }
    public List<CheckinItem> Items { get; set; } = new List<CheckinItem>();

    /// <summary>Files renamed in this check-in; every file whose latest version uses one goes in too, saved with its new name.</summary>
    public List<CheckinRename> Renames { get; set; } = new List<CheckinRename>();

    /// <summary>Find every problem, and change nothing (servers from part numbers on).</summary>
    public bool DryRun { get; set; }
}

public sealed class CheckedInFile
{
    /// <summary>"created", "updated", "unchanged", or "renamed".</summary>
    public string Status { get; set; } = "";
    public VaultFile File { get; set; } = new VaultFile();
}

/// <summary>What a dry run says would happen to a file.</summary>
public sealed class PlannedFile
{
    public string Status { get; set; } = "";
    public string Path { get; set; } = "";
}

/// <summary>A problem a dry run found, as the check-in's refusal would say it.</summary>
public sealed class CheckinProblem
{
    /// <summary>The refusal's code, as VaultApiException.Code has it.</summary>
    public string Error { get; set; } = "";
    public string Message { get; set; } = "";
    public Dictionary<string, System.Text.Json.JsonElement> Details { get; set; } = new Dictionary<string, System.Text.Json.JsonElement>();
}

public sealed class CheckinResult
{
    /// <summary>Null when nothing changed, and for a dry run.</summary>
    public long? CheckinId { get; set; }
    public List<CheckedInFile> Files { get; set; } = new List<CheckedInFile>();

    /// <summary>A dry run's: what would happen to each file, if it found no problems.</summary>
    public List<PlannedFile> Planned { get; set; } = new List<PlannedFile>();

    /// <summary>A dry run's: every problem it found.</summary>
    public List<CheckinProblem> Problems { get; set; } = new List<CheckinProblem>();

    /// <summary>
    /// Not the server's: the links parts going in have to files deleted from the vault (the assembly a part was edited
    /// in, a part it's made from), which they're checked in without. A part opens without them.
    /// </summary>
    public List<DeletedLink> LeftOut { get; set; } = new List<DeletedLink>();
}

/// <summary>A part's link to a file deleted from the vault, which it's checked in without: both by vault path.</summary>
public sealed class DeletedLink
{
    public string File { get; set; } = "";
    public string Deleted { get; set; } = "";
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

    /// <summary>An admin has the vault paused: changes wait until it's back. Null when it isn't (and from older servers).</summary>
    public PauseInfo? Paused { get; set; }
}

/// <summary>An admin's pause: every change but theirs, from the computer they paused it on, waits until it's unpaused.</summary>
public sealed class PauseInfo
{
    public UserRef By { get; set; } = new UserRef();
    public DateTimeOffset Since { get; set; }
    public string Host { get; set; } = "";
    public string Reason { get; set; } = "";
}

/// <summary>Whether new files take part numbers ("off", "offer", or "require"), and the next number to hand out.</summary>
public sealed class NumberingInfo
{
    public string Mode { get; set; } = "off";
    public long NextNumber { get; set; }
}

/// <summary>A kind of part number, its last three digits: 001 Part, 501 Assembly.</summary>
public sealed class PartKind
{
    public string Code { get; set; } = "";
    public string Label { get; set; } = "";

    /// <summary>"part", "assembly", or "any".</summary>
    public string Applies { get; set; } = "";
    public bool Retired { get; set; }
}

/// <summary>A part number handed out: 00000123-001, with what the file that takes it is to be called.</summary>
public sealed class IssuedNumber
{
    public string Number { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Title { get; set; } = "";
    public DateTimeOffset IssuedAt { get; set; }

    /// <summary>The file that has it, once one does.</summary>
    public long? FileId { get; set; }
}

/// <summary>A file's title, or whether it's a vendor's part, to change (null leaves either as it is).</summary>
public sealed class FileDescription
{
    public long File { get; set; }
    public string? Title { get; set; }
    public bool? Vendor { get; set; }
}

internal sealed class IssuedNumberList
{
    public List<IssuedNumber> Numbers { get; set; } = new List<IssuedNumber>();
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

/// <summary>A file the server offers for download (GET /api/downloads), like the add-in's installer.</summary>
public sealed class Download
{
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public DateTimeOffset ModifiedAt { get; set; }

    /// <summary>A Windows program's version, like "0.5.0", from the program itself; null for other files, and from servers before 0.5.0.</summary>
    public string? Version { get; set; }

    /// <summary>Null from servers before 0.5.0.</summary>
    public string? Sha256 { get; set; }
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

/// <summary>A version's 3D model in one configuration, for Caliper, the web app's 3D viewer.</summary>
public sealed class CaliperModelInfo
{
    public int Version { get; set; }
    public string Configuration { get; set; } = "";

    /// <summary>"part" (a mesh) or "assembly" (its components).</summary>
    public string Kind { get; set; } = "";
    public string Units { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public UserRef CreatedBy { get; set; } = new UserRef();
}

/// <summary>A file's version, in a configuration: what a 3D model is of.</summary>
internal sealed class CaliperModelKey
{
    public long FileId { get; set; }
    public int Version { get; set; }
    public string Configuration { get; set; } = "";
}

internal sealed class CaliperModelRequest
{
    public int Version { get; set; }
    public string Configuration { get; set; } = "";
    public string Units { get; set; } = "mm";

    /// <summary>A part's: the SHA-256 of its mesh, uploaded first.</summary>
    public string? Mesh { get; set; }

    /// <summary>An assembly's.</summary>
    public List<CaliperComponentRequest>? Components { get; set; }
}

internal sealed class CaliperComponentRequest
{
    public string Name { get; set; } = "";
    public long? FileId { get; set; }
    public int? Version { get; set; }
    public string Configuration { get; set; } = "";
    public double[] Transform { get; set; } = CaliperTransforms.Identity;
    public bool Hidden { get; set; }
    public double[]? Color { get; set; }
    public double Opacity { get; set; } = 1;
    public string? Mesh { get; set; }
    public List<CaliperComponentRequest> Children { get; set; } = new List<CaliperComponentRequest>();
}

internal sealed class CaliperModelList
{
    public List<CaliperModelInfo> Models { get; set; } = new List<CaliperModelInfo>();
}

internal sealed class CaliperMissing
{
    public List<CaliperModelKey> Missing { get; set; } = new List<CaliperModelKey>();
}

/// <summary>The PDF of a drawing's version, of all its sheets, that Caliper shows in the web app.</summary>
public sealed class DrawingPdfInfo
{
    public long Size { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public UserRef CreatedBy { get; set; } = new UserRef();
}

/// <summary>A drawing's version: what a PDF is of.</summary>
internal sealed class DrawingKey
{
    public long FileId { get; set; }
    public int Version { get; set; }
}

internal sealed class DrawingPdfRequest
{
    public int Version { get; set; }

    /// <summary>The SHA-256 of the PDF, uploaded first.</summary>
    public string Pdf { get; set; } = "";
}

internal sealed class DrawingsMissing
{
    public List<DrawingKey> Missing { get; set; } = new List<DrawingKey>();
}
