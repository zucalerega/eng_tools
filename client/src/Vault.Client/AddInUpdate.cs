namespace Vault.Client;

/// <summary>
/// Updating the SolidWorks add-in from its server. The server offers the add-in's installer with the version it
/// installs and its SHA-256 (GET /api/downloads); the add-in offers to update when that version is newer than its
/// own, and the installer is checked before it runs.
/// </summary>
public static class AddInUpdate
{
    public const string InstallerName = "Vault-Setup.exe";

    /// <summary>The installer on offer, if it installs a newer add-in than the one running; else null.</summary>
    public static Download? Newer(IEnumerable<Download> downloads, Version running) =>
        downloads.FirstOrDefault(d =>
            string.Equals(d.Name, InstallerName, StringComparison.OrdinalIgnoreCase)
            && d.Sha256 != null
            && Version.TryParse(d.Version, out var offered)
            && Release(offered!) > Release(running));

    /// <summary>
    /// Download the installer into folder, checked against its size and SHA-256 before it's put in place, and return
    /// where it is. A failed or damaged download leaves nothing behind.
    /// </summary>
    public static async Task<string> DownloadAsync(VaultApi api, Download installer, string folder, CancellationToken ct = default)
    {
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, $"Vault-Setup-{installer.Version}.exe");
        var temp = path + ".download";
        try
        {
            using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await api.DownloadSoftwareAsync(installer.Name, file, ct).ConfigureAwait(false);
            }
            if (new FileInfo(temp).Length != installer.Size || Hashing.Sha256File(temp) != installer.Sha256)
            {
                throw new WorkspaceException($"The download of {installer.Name} was damaged; try again");
            }
            if (File.Exists(path))
            {
                File.Delete(path);
            }
            File.Move(temp, path);
            return path;
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    // Releases are major.minor.build: 0.5.0 is 0.5.0.0, whichever way it's written.
    private static Version Release(Version version) => new Version(version.Major, version.Minor, Math.Max(0, version.Build));
}
