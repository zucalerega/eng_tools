namespace Vault.Client.Tests;

/// <summary>Saved sign-ins.</summary>
public sealed class TokenStoreTests : IDisposable
{
    private static readonly Uri Server = new Uri("https://yjsp.example.org/");
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-tokens-" + Guid.NewGuid().ToString("N"));

    public void Dispose() => TempFolders.Delete(_temp);

    [Fact]
    public void SignInsRoundTrip()
    {
        var store = new TokenStore(Path.Combine(_temp, "tokens.json"));
        Assert.Null(store.Load(Server));
        store.Save(Server, "yjsp_secret");
        Assert.Equal("yjsp_secret", new TokenStore(store.FilePath).Load(Server));
        Assert.True(store.Remove(Server));
        Assert.Null(store.Load(Server));
    }

    [Theory]
    [InlineData("zeros")] // what Windows leaves of a file it hadn't finished saving when the computer lost power
    [InlineData("empty")]
    [InlineData("half")]
    public void ADamagedFileMeansSigningInAgain(string damage)
    {
        var store = new TokenStore(Path.Combine(_temp, "tokens.json"));
        store.Save(Server, "yjsp_secret");
        var whole = File.ReadAllBytes(store.FilePath);
        File.WriteAllBytes(store.FilePath, damage switch
        {
            "zeros" => new byte[whole.Length],
            "empty" => Array.Empty<byte>(),
            _ => whole.Take(whole.Length / 2).ToArray(),
        });

        Assert.Null(store.Load(Server));
        Assert.False(store.Remove(Server));
        store.Save(Server, "yjsp_again");
        Assert.Equal("yjsp_again", new TokenStore(store.FilePath).Load(Server));
        Assert.Equal(["tokens.json"], Directory.GetFiles(_temp).Select(Path.GetFileName)); // nothing left from saving it
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(store.FilePath));
        }
    }
}
