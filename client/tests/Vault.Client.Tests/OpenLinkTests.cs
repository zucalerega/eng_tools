namespace Vault.Client.Tests;

/// <summary>vault:// links: what the web app makes, and what vault-open.exe accepts.</summary>
public sealed class OpenLinkTests
{
    [Fact]
    public void LinksRoundTrip()
    {
        var open = OpenLink.For(new Uri("https://yjsp.example.org/"), "Structures/Fins/Fin Can.SLDASM");
        Assert.StartsWith("vault://open?", open);
        var link = OpenLink.Parse(open);
        Assert.Equal((LinkAction.Open, "https://yjsp.example.org/", "Structures/Fins/Fin Can.SLDASM"), (link.Action, link.Server.AbsoluteUri, link.VaultPath));

        var drawing = OpenLink.Parse(OpenLink.ForNew(new Uri("https://yjsp.example.org/"), "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT"));
        Assert.Equal((LinkAction.New, "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT"), (drawing.Action, drawing.VaultPath, drawing.Model));

        var connect = OpenLink.Parse(OpenLink.ForConnect(new Uri("https://yjsp.example.org/")));
        Assert.Equal((LinkAction.Connect, "https://yjsp.example.org/", ""), (connect.Action, connect.Server.AbsoluteUri, connect.VaultPath));
    }

    [Fact]
    public void ConnectLinksFromTheWebAppParse()
    {
        // As the SolidWorks page writes it: just the server, which is all it needs.
        var link = "vault://connect?server=https%3A%2F%2Flucazerega.tail07089c.ts.net";
        var parsed = OpenLink.Parse(link);
        Assert.Equal((LinkAction.Connect, "https://lucazerega.tail07089c.ts.net/"), (parsed.Action, parsed.Server.AbsoluteUri));
        Assert.Throws<WorkspaceException>(() => OpenLink.Parse(link.Split('?')[0] + "?path=A.SLDPRT")); // no server
    }

    [Theory]
    // As the web app writes them (URLSearchParams: + for spaces), and with the slash some browsers add.
    [InlineData("vault://open?server=http%3A%2F%2Flocalhost%3A8000&path=Test%2FPart1.SLDPRT", "http://localhost:8000/", "Test/Part1.SLDPRT")]
    [InlineData("vault://open/?server=https%3A%2F%2Fyjsp.example.org&path=Recovery%2FMain+Chute.SLDPRT", "https://yjsp.example.org/", "Recovery/Main Chute.SLDPRT")]
    [InlineData("Vault://Open?path=A.STEP&server=https%3A%2F%2Fyjsp.example.org", "https://yjsp.example.org/", "A.STEP")]
    public void LinksFromTheWebAppParse(string link, string server, string path)
    {
        var parsed = OpenLink.Parse(link);
        Assert.Equal((LinkAction.Open, server, path), (parsed.Action, parsed.Server.AbsoluteUri, parsed.VaultPath));
    }

    [Theory]
    [InlineData("vault://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fins%2FFin+Bracket.SLDPRT", "Fins/Fin Bracket.SLDPRT", null)]
    [InlineData("vault://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fin+Can.sldasm&model=Fins%2FFin.SLDPRT", "Fin Can.sldasm", null)] // only drawings have one
    [InlineData("vault://new?server=http%3A%2F%2Flocalhost%3A8000&path=Fins%2FFin.SLDDRW&model=Fins%2FFin.SLDPRT", "Fins/Fin.SLDDRW", "Fins/Fin.SLDPRT")]
    public void NewFileLinksParse(string link, string path, string? model)
    {
        var parsed = OpenLink.Parse(link);
        Assert.Equal((LinkAction.New, path, model), (parsed.Action, parsed.VaultPath, parsed.Model));
    }

    [Theory]
    [InlineData("https://yjsp.example.org/file/12")] // not a vault: link
    [InlineData("vaults://open?server=https%3A%2F%2Fyjsp.example.org&path=A.SLDPRT")] // nor something like one
    [InlineData("vault://delete?server=https%3A%2F%2Fyjsp.example.org&path=A.SLDPRT")] // neither open nor new
    [InlineData("vault://open/elsewhere?server=https%3A%2F%2Fyjsp.example.org&path=A.SLDPRT")]
    [InlineData("vault://open?path=A.SLDPRT")] // no server
    [InlineData("vault://open?server=file%3A%2F%2F%2FC%3A%2FWindows&path=A.SLDPRT")] // not a web server
    [InlineData("vault://open?server=https%3A%2F%2Fyjsp.example.org")] // no file
    [InlineData("vault://new?server=https%3A%2F%2Fyjsp.example.org&path=Bolt.STEP")] // SolidWorks can't start one
    [InlineData("vault://new?server=https%3A%2F%2Fyjsp.example.org&path=Fin.SLDDRW")] // a drawing of nothing
    [InlineData("vault://new?server=https%3A%2F%2Fyjsp.example.org&path=Fin.SLDDRW&model=Other.SLDDRW")] // of a drawing
    public void AnythingElseIsRefused(string link) =>
        Assert.Throws<WorkspaceException>(() => OpenLink.Parse(link));

    [Theory]
    [InlineData("vault://open?server=https%3A%2F%2Fyjsp.example.org&path=..%2F..%2FWindows%2Fwin.ini")]
    [InlineData("vault://new?server=https%3A%2F%2Fyjsp.example.org&path=A.SLDDRW&model=..%2FA.SLDPRT")]
    public void PathsFollowTheVaultsRules(string link) =>
        Assert.Throws<VaultPathException>(() => OpenLink.Parse(link));
}
