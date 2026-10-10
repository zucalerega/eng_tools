using System.Text;

namespace Vault.Client.Tests;

/// <summary>The add-in's update: offered when the server has a newer installer, and checked before it runs.</summary>
[Collection("server")]
public sealed class AddInUpdateTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-update-" + Guid.NewGuid().ToString("N"));

    public AddInUpdateTests(ServerFixture server) => _server = server;

    private string Installer => Path.Combine(_server.DownloadsFolder, AddInUpdate.InstallerName);

    public void Dispose()
    {
        File.Delete(Installer);
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
        File.WriteAllBytes(Installer, setup);
        using var api = new VaultApi(_server.Url, _server.ChiefToken);

        var offered = AddInUpdate.Newer(await api.DownloadsAsync(), new Version(0, 5, 0, 0));
        Assert.NotNull(offered);
        Assert.Equal("0.6.0", offered.Version);
        Assert.Equal(setup, File.ReadAllBytes(await AddInUpdate.DownloadAsync(api, offered, _temp)));

        // Changed on the server since it was offered: not what was offered, so it isn't kept.
        Directory.Delete(_temp, recursive: true);
        File.WriteAllBytes(Installer, Program(0, 6, 1));
        await Assert.ThrowsAsync<WorkspaceException>(() => AddInUpdate.DownloadAsync(api, offered, _temp));
        Assert.Empty(Directory.GetFiles(_temp));
    }

    // A stand-in installer with a version resource, as the server reads it (as in server/tests/test_trash.py).
    private static byte[] Program(int major, int minor, int build)
    {
        uint[] fixedInfo = [0xFEEF04BD, 0x10000, (uint)((major << 16) | minor), (uint)(build << 16)];
        return
        [
            .. Encoding.ASCII.GetBytes("MZ"),
            .. new byte[64],
            .. Encoding.Unicode.GetBytes("VS_VERSION_INFO"),
            0,
            0,
            .. fixedInfo.SelectMany(word => BitConverter.GetBytes(word)),
            .. new byte[36],
        ];
    }
}
