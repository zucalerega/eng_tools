using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Vault.Client;

/// <summary>
/// Updating the SolidWorks add-in from its server. The server offers the add-in's installer with the version it
/// installs and its SHA-256 (GET /api/downloads), and beside it the installer's signature (Vault-Setup.exe.sig). The
/// add-in offers to update when that version is newer than its own, and runs the installer only once it's checked:
/// signed with the key CI signs Vault's releases with, whose public half the add-in carries, so that a server (or
/// whoever has it) can't put a program of its own on every team laptop; and the version it was offered as.
/// </summary>
public static class AddInUpdate
{
    public const string InstallerName = "Vault-Setup.exe";

    /// <summary>The ending of the installer's signature, beside it on the server: Vault-Setup.exe.sig.</summary>
    public const string SignatureSuffix = ".sig";

    // An RSA PKCS#1 v1.5 signature is as long as its key: 384 bytes for this one, and anything over 8192 bits' isn't one.
    private const int MaxSignature = 1024;

    // The public half of the key that signs Vault-Setup.exe: RSA 3072, PKCS#1 v1.5 over the installer's SHA-256, as
    // `openssl dgst -sha256 -sign` signs (with exponent 65537). It's installer-signing.pub.pem, beside this file. The
    // private half is only in CI's INSTALLER_SIGNING_KEY secret and the owner's password manager. A new key comes in a
    // release signed with this one (docs/deploying.md, "Signing key").
    private const string SigningKeyModulus =
        "E8F530DBAFE8F36D962301E691B5A76F3201CC98B3E8531E76812078702F0727570D4FE93DF48A33F0834EF9C6777C7CAB62AF21D0E1CA309A6C5B564F4943B4"
        + "92B8E3665DF330889F1EAA8A68761BD62B139EAD69CF3B19FCA0612352F0134BF29AD576A91C9B5B1D62552A62E89B68FB520C2CDD8B824C250087C821DE29D7"
        + "91E543AF6843F2700C9EDE4DF53017571BD30F8D05339A4AC50909DA361DD72E03C1E8EFEACD51B02C2B4AF36302F8138B6BF59E606CB8C73CC5AAC5424EF0A2"
        + "3115880AFA860EF1561F6DE9764C2C8E13F969B057403654742BB22A0C4285D4B423E3EFB513BACFAF2C7004392277A077FF63636E8CAFA353D118F2292D2EA0"
        + "BB1B4E3C718B1E1D8CC6D50E018385255BA44BF8D431EC0879A7C559A9CD85CCD5AC4D9F04ECA9B42FA132F87A802B1B12095DD477E456E91153B74A45389C39"
        + "D73C638210A8BC1858A7D1B59981D3B605E1ECDF63C799E2148AAF7443D6E3AA39180E69F1CB7A50CC279F189DA99A750531B084F8F60CD3FFC94C9486A52DF1";

    /// <summary>The key installers have to be signed with: the public half of the one CI signs releases with.</summary>
    internal static RSAParameters SigningKey => new RSAParameters { Modulus = FromHex(SigningKeyModulus), Exponent = new byte[] { 1, 0, 1 } };

    /// <summary>The installer on offer, if it installs a newer add-in than the one running; else null.</summary>
    public static Download? Newer(IEnumerable<Download> downloads, Version running) =>
        downloads.FirstOrDefault(d =>
            string.Equals(d.Name, InstallerName, StringComparison.OrdinalIgnoreCase)
            && d.Sha256 != null
            && Version.TryParse(d.Version, out var offered)
            && Release(offered!) > Release(running));

    /// <summary>
    /// Download the installer into folder and check it before it's put in place: its size and SHA-256 against what was
    /// offered, its signature (from the server, beside it) against the key the add-in carries, and its own version against
    /// the one it was offered as. Returns where it is. Anything amiss is a WorkspaceException saying what, and leaves
    /// nothing behind.
    /// </summary>
    public static Task<string> DownloadAsync(VaultApi api, Download installer, string folder, CancellationToken ct = default) =>
        DownloadAsync(api, installer, folder, SigningKey, ct);

    // The same, checked with another key: tests sign with their own.
    internal static async Task<string> DownloadAsync(VaultApi api, Download installer, string folder, RSAParameters key, CancellationToken ct = default)
    {
        if (!Version.TryParse(installer.Version, out var offered))
        {
            throw new WorkspaceException($"The server doesn't say which version {installer.Name} is, so Vault won't install it");
        }
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, $"Vault-Setup-{Release(offered)}.exe");
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
            var signature = await SignatureAsync(api, installer.Name, ct).ConfigureAwait(false)
                ?? throw new WorkspaceException(
                    $"{installer.Name} on the server has no signature ({installer.Name}{SignatureSuffix}), so Vault won't install it: an "
                    + "update has to be signed with the key Vault's releases are signed with. Tell whoever runs your vault.");
            if (!IsSigned(temp, signature, key))
            {
                throw new WorkspaceException(
                    $"{installer.Name} on the server isn't signed with the key Vault's releases are signed with, so Vault won't install it. "
                    + "If it was put there just now, try again in a few minutes; if not, tell whoever runs your vault.");
            }
            // Signed, so it's one of Vault's own releases: and the one offered, not an older one said to be newer.
            var version = ProgramVersion(File.ReadAllBytes(temp));
            if (version == null || Release(version) != Release(offered))
            {
                throw new WorkspaceException(
                    $"{installer.Name} on the server is version {(version == null ? "unknown" : Text(version))}, not {Text(offered)} as the "
                    + "server says, so Vault won't install it. Tell whoever runs your vault.");
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

    /// <summary>Whether signature is file's, made with key's private half: RSA PKCS#1 v1.5 over its SHA-256.</summary>
    internal static bool IsSigned(string file, byte[] signature, RSAParameters key)
    {
        using var rsa = RSA.Create();
        rsa.ImportParameters(key);
        using var data = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            return rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch (CryptographicException)
        {
            return false; // not even the shape of a signature by this key
        }
    }

    /// <summary>
    /// "major.minor.build" from a Windows program's version resource, read as the server reads it (api/downloads.py): the
    /// last "VS_VERSION_INFO" key in the file is the program's own (what it carries inside it comes before), and its
    /// VS_FIXEDFILEINFO, which starts 0xFEEF04BD, follows within a few bytes of padding, with the version in its third and
    /// fourth words. Null if there's none.
    /// </summary>
    internal static Version? ProgramVersion(byte[] data)
    {
        var name = Encoding.Unicode.GetBytes("VS_VERSION_INFO");
        var key = LastIndexOf(data, name);
        if (key < 0)
        {
            return null;
        }
        var info = -1;
        for (var at = key + name.Length; at <= key + name.Length + 4 && at + 4 <= data.Length; at++)
        {
            if (Word(data, at) == 0xFEEF04BD)
            {
                info = at;
                break;
            }
        }
        if (info < 0 || data.Length < info + 16)
        {
            return null;
        }
        uint high = Word(data, info + 8), low = Word(data, info + 12);
        return new Version((int)(high >> 16), (int)(high & 0xFFFF), (int)(low >> 16));
    }

    // The installer's signature from beside it on the server: null if there's none, and nothing if it's too big to be one.
    private static async Task<byte[]?> SignatureAsync(VaultApi api, string installer, CancellationToken ct)
    {
        try
        {
            return await api.DownloadSoftwareAsync(installer + SignatureSuffix, MaxSignature, ct).ConfigureAwait(false);
        }
        catch (VaultApiException e) when (e.StatusCode == 404)
        {
            return null;
        }
        catch (VaultApiException e) when (e.Code == VaultApi.TooBig)
        {
            return Array.Empty<byte>();
        }
    }

    // Releases are major.minor.build: 0.5.0 is 0.5.0.0, whichever way it's written.
    private static Version Release(Version version) => new Version(version.Major, version.Minor, Math.Max(0, version.Build));

    private static string Text(Version version) => Release(version).ToString(3);

    private static uint Word(byte[] data, int at) =>
        (uint)(data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)); // little-endian, as in the file

    private static int LastIndexOf(byte[] data, byte[] part)
    {
        for (var at = data.Length - part.Length; at >= 0; at--)
        {
            var i = 0;
            while (i < part.Length && data[at + i] == part[i])
            {
                i++;
            }
            if (i == part.Length)
            {
                return at;
            }
        }
        return -1;
    }

    private static byte[] FromHex(string hex)
    {
        var bytes = new byte[hex.Length / 2];
        for (var i = 0; i < bytes.Length; i++)
        {
            bytes[i] = byte.Parse(hex.Substring(2 * i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }
        return bytes;
    }
}
