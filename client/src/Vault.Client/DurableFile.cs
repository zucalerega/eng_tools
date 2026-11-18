using System.Text;

namespace Vault.Client;

/// <summary>
/// Saving a small file the client can't do without (a workspace's state, the saved sign-ins) so that a crash or a
/// power cut leaves the old file or the new one, whole. It's written beside the file, flushed to the disk, and only
/// then renamed over it. Without the flush, Windows can keep the rename and lose the contents: the file comes back
/// the right length and all zeros, which is no JSON at all.
/// </summary>
internal static class DurableFile
{
    /// <summary>Replace a file's text. With ownerOnly, off Windows, only its owner can read it, from the moment it exists.</summary>
    public static void WriteAllText(string path, string text, bool ownerOnly = false)
    {
        var temp = path + ".tmp";
        File.Delete(temp); // one left by a save that never finished, so this one is made new, as it should be
        using (var stream = Create(temp, ownerOnly))
        {
            var bytes = new UTF8Encoding(false).GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(flushToDisk: true);
        }
        if (File.Exists(path))
        {
            File.Replace(temp, path, null);
        }
        else
        {
            File.Move(temp, path);
        }
    }

    private static FileStream Create(string path, bool ownerOnly)
    {
#if NET7_0_OR_GREATER
        if (ownerOnly && !OperatingSystem.IsWindows())
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            };
            return new FileStream(path, options);
        }
#endif
        return new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
    }
}
