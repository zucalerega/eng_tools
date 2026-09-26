namespace Cvc.Client.Tests;

/// <summary>cvc://open links: what the web app makes, and what cvc-open.exe accepts.</summary>
public sealed class OpenLinkTests
{
    [Fact]
    public void LinksRoundTrip()
    {
        var link = OpenLink.For(new Uri("https://cvc.example.org/"), "Structures/Fins/Fin Can.SLDASM");
        var (server, path) = OpenLink.Parse(link);
        Assert.Equal(("https://cvc.example.org/", "Structures/Fins/Fin Can.SLDASM"), (server.AbsoluteUri, path));
    }

    [Theory]
    // As the web app writes them (URLSearchParams: + for spaces), and with the slash some browsers add.
    [InlineData("cvc://open?server=http%3A%2F%2Flocalhost%3A8000&path=Test%2FPart1.SLDPRT", "http://localhost:8000/", "Test/Part1.SLDPRT")]
    [InlineData("cvc://open/?server=https%3A%2F%2Fcvc.example.org&path=Recovery%2FMain+Chute.SLDPRT", "https://cvc.example.org/", "Recovery/Main Chute.SLDPRT")]
    [InlineData("CVC://Open?path=A.STEP&server=https%3A%2F%2Fcvc.example.org", "https://cvc.example.org/", "A.STEP")]
    public void LinksFromTheWebAppParse(string link, string server, string path)
    {
        var parsed = OpenLink.Parse(link);
        Assert.Equal((server, path), (parsed.Server.AbsoluteUri, parsed.VaultPath));
    }

    [Theory]
    [InlineData("https://cvc.example.org/file/12")] // not a cvc: link
    [InlineData("cvc://delete?server=https%3A%2F%2Fcvc.example.org&path=A.SLDPRT")] // not open
    [InlineData("cvc://open/elsewhere?server=https%3A%2F%2Fcvc.example.org&path=A.SLDPRT")]
    [InlineData("cvc://open?path=A.SLDPRT")] // no server
    [InlineData("cvc://open?server=file%3A%2F%2F%2FC%3A%2FWindows&path=A.SLDPRT")] // not a web server
    [InlineData("cvc://open?server=https%3A%2F%2Fcvc.example.org")] // no file
    public void AnythingElseIsRefused(string link) =>
        Assert.Throws<WorkspaceException>(() => OpenLink.Parse(link));

    [Fact]
    public void PathsFollowTheVaultsRules() =>
        Assert.Throws<VaultPathException>(() => OpenLink.Parse("cvc://open?server=https%3A%2F%2Fcvc.example.org&path=..%2F..%2FWindows%2Fwin.ini"));
}
