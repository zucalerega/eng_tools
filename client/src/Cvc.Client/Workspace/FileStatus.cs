namespace Cvc.Client;

public enum FileState
{
    /// <summary>The local copy is the latest version, unchanged.</summary>
    UpToDate,

    /// <summary>The local copy is an older version, unchanged: get latest.</summary>
    Outdated,

    /// <summary>The local copy has changes on top of the latest version (normal while checked out).</summary>
    Modified,

    /// <summary>Changed locally, but someone checked in a newer version since (or a different file is in the way).</summary>
    Conflict,

    /// <summary>In the vault, not downloaded here.</summary>
    Missing,

    /// <summary>Only here, not in the vault yet: check it in to add it.</summary>
    New,

    /// <summary>Came from the vault, but has been deleted there since.</summary>
    DeletedInVault,
}

public sealed class FileStatus
{
    public string VaultPath { get; internal set; } = "";
    public string LocalPath { get; internal set; } = "";
    public long? FileId { get; internal set; }
    public FileState State { get; internal set; }
    public int? LocalVersion { get; internal set; }
    public int? RemoteVersion { get; internal set; }

    /// <summary>Who has it checked out, if anyone.</summary>
    public FileLock? Lock { get; internal set; }

    /// <summary>Checked out by you, on this computer.</summary>
    public bool CheckedOutByMe { get; internal set; }

    /// <summary>Your role in the file's folder: viewer, editor, lead, or admin (null if unknown).</summary>
    public string? MyRole { get; internal set; }
}

public sealed class GetResult
{
    public List<FileStatus> Downloaded { get; } = new List<FileStatus>();

    /// <summary>Changed locally, so left alone (use force to replace them).</summary>
    public List<FileStatus> Skipped { get; } = new List<FileStatus>();

    /// <summary>Deleted from the workspace because they were deleted in the vault.</summary>
    public List<FileStatus> Removed { get; } = new List<FileStatus>();

    /// <summary>Where local changes were saved before being replaced.</summary>
    public List<string> BackedUp { get; } = new List<string>();

    /// <summary>Files that couldn't be updated, and why (for example, open in SolidWorks).</summary>
    public List<string> Failures { get; } = new List<string>();
}

/// <summary>How much a get would download: files not here yet, newer versions of files that are, and their total size.</summary>
public sealed class DownloadSize
{
    public int NewFiles { get; private set; }

    public int UpdatedFiles { get; private set; }

    public long Bytes { get; private set; }

    public int Files => NewFiles + UpdatedFiles;

    internal void Add(bool isNew, long bytes)
    {
        if (isNew)
        {
            NewFiles++;
        }
        else
        {
            UpdatedFiles++;
        }
        Bytes += bytes;
    }
}

public sealed class UndoResult
{
    public List<FileStatus> Released { get; } = new List<FileStatus>();

    /// <summary>Where discarded local changes were saved.</summary>
    public List<string> BackedUp { get; } = new List<string>();
}

public sealed class WorkspaceException : Exception
{
    public WorkspaceException(string message)
        : base(message)
    {
    }

    public WorkspaceException(string message, Exception inner)
        : base(message, inner)
    {
    }
}
