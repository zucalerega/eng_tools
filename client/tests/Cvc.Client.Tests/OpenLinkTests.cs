namespace Cvc.Client.Tests;

/// <summary>cvc:// links: what the web app makes, and what cvc-open.exe accepts.</summary>
public sealed class OpenLinkTests
{
    [Fact]
    public void LinksRoundTrip()
    {
        var link = OpenLink.Parse(OpenLink.For(new Uri("https://cvc.example.org/"), "Structures/Fins/Fin Can.SLDASM"));
        Assert.Equal((LinkAction.Open, "https://cvc.example.org/", "Structures/Fins/Fin Can.SLDASM"), (link.Action, link.Server.AbsoluteUri, link.VaultPath));

        var drawing = OpenLink.Parse(OpenLink.ForNew(new Uri("https://cvc.example.org/"), "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT"));
        Assert.Equal((LinkAction.New, "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT"), (drawing.Action, drawing.VaultPath, drawing.Model));
    }

    [Theory]
    // As the web app writes them (URLSearchParams: + for spaces), and with the slash some browsers add.
    [InlineData("cvc://open?server=http%3A%2F%2Flocalhost%3A8000&path=Test%2FPart1.SLDPRT", "http://localhost:8000/", "Test/Part1.SLDPRT")]
    [InlineData("cvc://open/?server=https%3A%2F%2Fcvc.example.org&path=Recovery%2FMain+Chute.SLDPRT", "https://cvc.example.org/", "Recovery/Main Chute.SLDPRT")]
    [InlineData("CVC://Open?path=A.STEP&server=https%3A%2F%2Fcvc.example.org", "https://cvc.example.org/", "A.STEP")]
    public void LinksFromTheWebAppParse(string link, string server, string path)
    {
        var parsed = OpenLink.Parse(link);
        Assert.Equal((LinkAction.Open, server, path), (parsed.Action, parsed.Server.AbsoluteUri, parsed.VaultPath));
    }

    [Theory]
    [InlineData("cvc://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fins%2FFin+Bracket.SLDPRT", "Fins/Fin Bracket.SLDPRT", null)]
    [InlineData("cvc://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fin+Can.sldasm&model=Fins%2FFin.SLDPRT", "Fin Can.sldasm", null)] // only drawings have one
    [InlineData("cvc://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fins%2FFin.SLDDRW&model=Fins%2FFin.SLDPRT", "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT")]
    public void NewFileLinksParse(string link, string path, string? model)
    {
        var parsed = OpenLink.Parse(link);
        Assert.Equal((LinkAction.New, path, model), (parsed.Action, parsed.VaultPath, parsed.Model));
    }

    [Theory]
    [InlineData("https://cvc.example.org/file/12")] // not a cvc: link
    [InlineData("cvc://delete?server=https%3A%2F%2Fcvc.example.org&path=A.SLDPRT")] // neither open nor new
    [InlineData("cvc://open/elsewhere?server=https%3A%2F%2Fcvc.example.org&path=A.SLDPRT")]
    [InlineData("cvc://open?path=A.SLDPRT")] // no server
    [InlineData("cvc://open?server=file%3A%2F%2F%2FC%3A%2FWindows&path=A.SLDPRT")] // not a web server
    [InlineData("cvc://open?server=https%3A%2F%2Fcvc.example.org")] // no file
    [InlineData("cvc://new?server=https%3A%2F%2Fcvc.example.org&path=Bolt.STEP")] // SolidWorks can't start one
    [InlineData("cvc://new?server=https%3A%2F%2Fcvc.example.org&path=Fin.SLDDRW")] // a drawing of nothing
    [InlineData("cvc://new?server=https%3A%2F%2Fcvc.example.org&path=Fin.SLDDRW&model=Other.SLDDRW")] // of a drawing
    public void AnythingElseIsRefused(string link) =>
        Assert.Throws<WorkspaceException>(() => OpenLink.Parse(link));

    [Theory]
    [InlineData("cvc://open?server=https%3A%2F%2Fcvc.example.org&path=..%2F..%2FWindows%2Fwin.ini")]
    [InlineData("cvc://new?server=https%3A%2F%2Fcvc.example.org&path=A.SLDDRW&model=..%2FA.SLDPRT")]
    public void PathsFollowTheVaultsRules(string link) =>
        Assert.Throws<VaultPathException>(() => OpenLink.Parse(link));
}
