using System.Text;

namespace Cvc.Client;

/// <summary>
/// Vault path rules, the same as the server's (server/src/yjsp_server/vault/paths.py), so bad names
/// are caught before anything is uploaded. Paths are '/'-separated and case-insensitive.
/// </summary>
public static class VaultPaths
{
    /// <summary>C:\VLT\ plus 200 characters stays under Windows' 260-character limit.</summary>
    public const int MaxPath = 200;
    public const int MaxName = 255;

    private const string InvalidCharacters = "<>:\"/\\|?*";
    private static readonly HashSet<string> Reserved = new HashSet<string>(
        new[] { "CON", "PRN", "AUX", "NUL" }
            .Concat(Enumerable.Range(1, 9).Select(i => "COM" + i))
            .Concat(Enumerable.Range(1, 9).Select(i => "LPT" + i)),
        StringComparer.OrdinalIgnoreCase);

    /// <summary>Validates one file or folder name; returns it NFC-normalized.</summary>
    public static string CleanName(string name)
    {
        name = name.Normalize(NormalizationForm.FormC);
        if (name.Length == 0 || name == "." || name == "..")
        {
            throw new VaultPathException($"'{name}' is not a valid name");
        }
        if (name.Length > MaxName)
        {
            throw new VaultPathException($"{name.Substring(0, 40)}... is longer than {MaxName} characters");
        }
        var bad = name.Where(c => InvalidCharacters.IndexOf(c) >= 0 || c < ' ').Distinct().ToList();
        if (bad.Count > 0)
        {
            throw new VaultPathException($"'{name}' contains characters Windows doesn't allow: {string.Join(" ", bad.Select(c => c < ' ' ? "control character" : c.ToString()))}");
        }
        if (name != name.Trim() || name.EndsWith(".", StringComparison.Ordinal))
        {
            throw new VaultPathException($"'{name}' starts or ends with a space, or ends with a dot");
        }
        if (Reserved.Contains(name.Split('.')[0]))
        {
            throw new VaultPathException($"'{name}' is a reserved name on Windows");
        }
        if (name.StartsWith("~$", StringComparison.Ordinal))
        {
            throw new VaultPathException($"'{name}' is a SolidWorks/Office temporary file");
        }
        return name;
    }

    /// <summary>Validated names along a path ('/' or '\' separated); empty for the root.</summary>
    public static IReadOnlyList<string> Split(string path)
    {
        var names = path.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(CleanName).ToList();
        if (string.Join("/", names).Length > MaxPath)
        {
            throw new VaultPathException($"{path} is longer than {MaxPath} characters");
        }
        return names;
    }

    /// <summary>Comparison key: names that differ only in case are the same file, as on Windows.</summary>
    public static string Key(string path) => path.Normalize(NormalizationForm.FormC).ToLowerInvariant();

    /// <summary>Local files CVC never adds to the vault: lock files, temporary files, OS clutter.</summary>
    public static bool IsIgnored(string name) =>
        name.StartsWith("~$", StringComparison.Ordinal)
        || name.StartsWith(".~", StringComparison.Ordinal)
        || name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith(Workspace.DownloadSuffix, StringComparison.Ordinal)
        || string.Equals(name, "Thumbs.db", StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, "desktop.ini", StringComparison.OrdinalIgnoreCase)
        || name == ".DS_Store";
}

public sealed class VaultPathException : Exception
{
    public VaultPathException(string message)
        : base(message)
    {
    }
}
