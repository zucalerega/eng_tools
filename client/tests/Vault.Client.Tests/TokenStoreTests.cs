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
}
