using System.Net;
using System.Text.RegularExpressions;

namespace Vault.Client.Tests;

/// <summary>Browser sign-in against the real server, with an HttpClient standing in for the browser.</summary>
[Collection("server")]
public sealed class SignInTests
{
    private readonly ServerFixture _server;

    public SignInTests(ServerFixture server) => _server = server;

    [Fact]
    public async Task BrowserSignInReturnsAWorkingToken()
    {
        const string email = "carol@rocketry.test";
        await _server.MemberTokenAsync(email); // approved account
        Task? browsing = null;
        var issued = await BrowserSignIn.SignInAsync(
            _server.Url, "vault test client", url => browsing = BrowseAsync(url, email, approve: true), TimeSpan.FromSeconds(30));
        await browsing!;

        Assert.Equal(email, issued.User.Email);
        using var api = new VaultApi(_server.Url, issued.Token);
        Assert.Equal(email, (await api.MeAsync()).Email);
    }

    [Fact]
    public async Task CancellingInTheBrowserFailsTheSignIn()
    {
        const string email = "dave@rocketry.test";
        await _server.MemberTokenAsync(email);
        Task? browsing = null;
        var error = await Assert.ThrowsAsync<VaultApiException>(() => BrowserSignIn.SignInAsync(
            _server.Url, "vault test client", url => browsing = BrowseAsync(url, email, approve: false), TimeSpan.FromSeconds(30)));
        await browsing!;
        Assert.Equal("access_denied", error.Code);
    }

    [Fact]
    public void CallbackQueriesAreDecoded()
    {
        var query = BrowserSignIn.ParseQuery("/callback?code=a%2Bb&state=x+y&flag");
        Assert.Equal("a+b", query["code"]);
        Assert.Equal("x y", query["state"]);
        Assert.Equal("", query["flag"]);
    }

    // What a person does in the browser: sign in, then Allow (or Cancel) on the confirmation page.
    private async Task BrowseAsync(Uri url, string email, bool approve)
    {
        using var handler = new HttpClientHandler { CookieContainer = new CookieContainer(), AllowAutoRedirect = false };
        using var browser = new HttpClient(handler) { BaseAddress = _server.Url };
        (await browser.GetAsync("auth/dev-login?email=" + Uri.EscapeDataString(email))).Dispose();
        var page = await browser.GetStringAsync(url);

        Uri callback;
        if (approve)
        {
            string Field(string name) =>
                WebUtility.HtmlDecode(Regex.Match(page, $"name=\"{name}\" value=\"([^\"]*)\"").Groups[1].Value);
            var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["port"] = Field("port"),
                ["state"] = Field("state"),
                ["challenge"] = Field("challenge"),
                ["name"] = Field("name"),
                ["approval"] = Field("approval"),
            });
            using var approved = await browser.PostAsync("auth/client/approve", form);
            Assert.Equal(HttpStatusCode.SeeOther, approved.StatusCode);
            callback = approved.Headers.Location!;
        }
        else
        {
            var cancel = Regex.Match(page, "href=\"(http://127\\.0\\.0\\.1:[^\"]+)\"").Groups[1].Value;
            callback = new Uri(WebUtility.HtmlDecode(cancel));
        }
        using var loopback = new HttpClient();
        (await loopback.GetAsync(callback)).Dispose(); // the redirect the browser would follow
    }
}
