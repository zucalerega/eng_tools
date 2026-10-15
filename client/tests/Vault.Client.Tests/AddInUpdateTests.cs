using System.Security.Cryptography;
using System.Text;

namespace Vault.Client.Tests;

/// <summary>
/// The add-in's update: offered when the server has a newer installer, and run only once it's checked, signature and
/// all. A throwaway key stands in for the one CI signs with.
/// </summary>
[Collection("server")]
public sealed class AddInUpdateTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-update-" + Guid.NewGuid().ToString("N"));
    private readonly RSA _key = RSA.Create(3072);

    public AddInUpdateTests(ServerFixture server) => _server = server;

    private string Installer => Path.Combine(_server.DownloadsFolder, AddInUpdate.InstallerName);

    private string Signature => Installer + AddInUpdate.SignatureSuffix;

    private RSAParameters PublicKey => _key.ExportParameters(includePrivateParameters: false);

    public void Dispose()
    {
        File.Delete(Installer);
        File.Delete(Signature);
        _key.Dispose();
        TempFolders.Delete(_temp);
    }

    [Theory]
    [InlineData("0.5.1", "0.5.0.0", true)]
    [InlineData("1.0.0", "0.9.12.0", true)]
    [InlineData("0.5.0", "0.5.0.0", false)] // the same release, written two ways
    [InlineData("0.4.9", "0.5.0.0", false)]
    [InlineData(null, "0.5.0.0", false)] // a server before 0.5.0 doesn't say
    public void OnlyANewerInstallerIsOffered(string? offered, string running, bool newer)
    {
        var downloads = new[]
        {
            new Download { Name = "vault.exe", Version = "9.9.9", Sha256 = "ab" }, // not the add-in's
            new Download { Name = "vault-setup.exe", Version = offered, Sha256 = "cd" },
        };
        Assert.Equal(newer, AddInUpdate.Newer(downloads, Version.Parse(running)) != null);
    }

    [Fact]
    public void AnInstallerWithoutItsHashIsntOffered() =>
        Assert.Null(AddInUpdate.Newer([new Download { Name = AddInUpdate.InstallerName, Version = "9.0.0" }], new Version(0, 5, 0)));

    [Fact]
    public async Task TheNewerInstallerDownloadsChecked()
    {
        var setup = Program(0, 6, 0);
        Publish(setup, Sign(setup, _key));
        using var api = new VaultApi(_server.Url, _server.ChiefToken);

        var downloads = await api.DownloadsAsync();
        Assert.DoesNotContain(downloads, d => d.Name.EndsWith(AddInUpdate.SignatureSuffix, StringComparison.OrdinalIgnoreCase)); // not for people
        var offered = AddInUpdate.Newer(downloads, new Version(0, 5, 0, 0));
        Assert.NotNull(offered);
        Assert.Equal("0.6.0", offered.Version);
        Assert.Equal(setup, File.ReadAllBytes(await AddInUpdate.DownloadAsync(api, offered, _temp, PublicKey)));

        // Changed on the server since it was offered: not what was offered, so it isn't kept.
        Directory.Delete(_temp, recursive: true);
        File.WriteAllBytes(Installer, Program(0, 6, 1));
        await Assert.ThrowsAsync<WorkspaceException>(() => AddInUpdate.DownloadAsync(api, offered, _temp, PublicKey));
        Assert.Empty(Directory.GetFiles(_temp));
    }

    [Fact]
    public async Task AnInstallerChangedAfterItWasSignedIsRefused()
    {
        // Whoever has the server swaps in their own program, and the server offers it, hash and all: only its signature
        // gives it away.
        var setup = Program(0, 6, 0);
        Publish(Program(0, 6, 0, inside: "something else"), Sign(setup, _key));

        var refused = await RefusedAsync(PublicKey);
        Assert.Contains("isn't signed with the key", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInstallerSignedWithAnotherKeyIsRefused()
    {
        using var other = RSA.Create(3072);
        var setup = Program(0, 6, 0);
        Publish(setup, Sign(setup, other));

        var refused = await RefusedAsync(PublicKey);
        Assert.Contains("isn't signed with the key", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnInstallerWithoutASignatureIsRefused()
    {
        Publish(Program(0, 6, 0), signature: null);

        var refused = await RefusedAsync(PublicKey);
        Assert.Contains("has no signature (Vault-Setup.exe.sig)", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASignatureTooBigToBeOneIsRefused()
    {
        Publish(Program(0, 6, 0), new byte[4096]);

        var refused = await RefusedAsync(PublicKey);
        Assert.Contains("isn't signed with the key", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnOlderInstallerOfferedAsNewerIsRefused()
    {
        // Signed, but an older release, which the server says is newer: its own version, which the signature covers, says
        // what it is.
        var older = Program(0, 5, 1);
        Publish(older, Sign(older, _key));
        using var api = new VaultApi(_server.Url, _server.ChiefToken);
        var listed = Assert.Single(await api.DownloadsAsync(), d => d.Name == AddInUpdate.InstallerName);
        var claimed = new Download { Name = listed.Name, Size = listed.Size, Sha256 = listed.Sha256, Version = "0.7.0" };

        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => AddInUpdate.DownloadAsync(api, claimed, _temp, PublicKey));
        Assert.Contains("is version 0.5.1, not 0.7.0", refused.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(_temp));
    }

    [Fact]
    public async Task TheKeyTheAddInCarriesIsTheOnlyOneItTakes()
    {
        // As the add-in calls it: with the key it carries, for which a throwaway key's signature is no good.
        var setup = Program(0, 6, 0);
        Publish(setup, Sign(setup, _key));
        using var api = new VaultApi(_server.Url, _server.ChiefToken);
        var offered = AddInUpdate.Newer(await api.DownloadsAsync(), new Version(0, 5, 0))!;

        await Assert.ThrowsAsync<WorkspaceException>(() => AddInUpdate.DownloadAsync(api, offered, _temp));
        Assert.Empty(Directory.GetFiles(_temp));
    }

    [Fact]
    public void TheKeyTheAddInCarriesIsTheOneInTheRepository()
    {
        // installer-signing.pub.pem, beside AddInUpdate: what CI checks each signature with (docs/deploying.md, "Signing key").
        using var file = RSA.Create();
        file.ImportFromPem(File.ReadAllText(Path.Combine(ClientLibraryFolder(), "installer-signing.pub.pem")));
        var fromFile = file.ExportParameters(includePrivateParameters: false);
        var carried = AddInUpdate.SigningKey;
        Assert.Equal(fromFile.Modulus, carried.Modulus);
        Assert.Equal(fromFile.Exponent, carried.Exponent);
        Assert.Equal(3072, carried.Modulus!.Length * 8);
    }

    // The update as offered, refused: nothing is left behind.
    private async Task<WorkspaceException> RefusedAsync(RSAParameters key)
    {
        using var api = new VaultApi(_server.Url, _server.ChiefToken);
        var offered = AddInUpdate.Newer(await api.DownloadsAsync(), new Version(0, 5, 0));
        Assert.NotNull(offered);
        var refused = await Assert.ThrowsAsync<WorkspaceException>(() => AddInUpdate.DownloadAsync(api, offered, _temp, key));
        Assert.Empty(Directory.GetFiles(_temp));
        return refused;
    }

    // What the server offers: an installer, and its signature beside it (or none).
    private void Publish(byte[] installer, byte[]? signature)
    {
        File.WriteAllBytes(Installer, installer);
        if (signature == null)
        {
            File.Delete(Signature);
        }
        else
        {
            File.WriteAllBytes(Signature, signature);
        }
    }

    // As CI signs it: `openssl dgst -sha256 -sign`, RSA PKCS#1 v1.5 over the file's SHA-256.
    private static byte[] Sign(byte[] installer, RSA key) => key.SignData(installer, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

    // A stand-in installer with a version resource, as the server reads it (as in server/tests/test_trash.py), after
    // anything it has inside it.
    private static byte[] Program(int major, int minor, int build, string inside = "")
    {
        uint[] fixedInfo = [0xFEEF04BD, 0x10000, (uint)((major << 16) | minor), (uint)(build << 16)];
        return
        [
            .. Encoding.ASCII.GetBytes("MZ" + inside),
            .. new byte[64],
            .. Encoding.Unicode.GetBytes("VS_VERSION_INFO"),
            0,
            0,
            .. fixedInfo.SelectMany(word => BitConverter.GetBytes(word)),
            .. new byte[36],
        ];
    }

    private static string ClientLibraryFolder()
    {
        for (var dir = AppContext.BaseDirectory; dir != null; dir = Path.GetDirectoryName(dir))
        {
            var library = Path.Combine(dir, "client", "src", "Vault.Client");
            if (File.Exists(Path.Combine(library, "Vault.Client.csproj")))
            {
                return library;
            }
        }
        throw new InvalidOperationException("Can't find the repository's client/src/Vault.Client folder");
    }
}
