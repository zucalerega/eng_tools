using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Vault.Client.Tests;

/// <summary>Saved sign-ins, and the ones a client from before 0.4.0 saved, which carry over.</summary>
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

    [Fact]
    public void SignInsSavedBeforeTheRenameAreTakenOver()
    {
        var old = Path.Combine(_temp, "CVC", "tokens.json");
        Directory.CreateDirectory(Path.GetDirectoryName(old)!);
        File.WriteAllText(old, JsonSerializer.Serialize(new Dictionary<string, string> { [Server.AbsoluteUri] = AsSavedBefore("cvc_secret") }));

        var store = new TokenStore(Path.Combine(_temp, "Vault", "tokens.json"), old);
        Assert.Equal("cvc_secret", store.Load(Server));
        Assert.True(File.Exists(store.FilePath)); // saved here, encrypted the new way
        Assert.True(File.Exists(old)); // and left there, for an older client still on the computer

        // From then on this file is the one: signing out here doesn't bring the old sign-in back.
        Assert.True(store.Remove(Server));
        Assert.Null(new TokenStore(store.FilePath, old).Load(Server));
    }

    /// <summary>A token as a client from before 0.4.0 saved it: DPAPI with that client's own entropy on Windows.</summary>
    private static string AsSavedBefore(string token)
    {
        if (OperatingSystem.IsWindows())
        {
            var entropy = Encoding.UTF8.GetBytes("cvc-token");
            return "dpapi:" + Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), entropy, DataProtectionScope.CurrentUser));
        }
        return "plain:" + token;
    }
}
