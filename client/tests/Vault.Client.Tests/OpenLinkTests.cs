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
    [InlineData("vault://connect?server=https%3A%2F%2Flucazerega.tail07089c.ts.net%40evil.example")] // the part before @ isn't the server
    [InlineData("vault://connect?server=https%3A%2F%2Fyjsp.example.org%2F%3Fnext%3Delsewhere")] // nor is a query part of it
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

    [Fact]
    public void ConnectingToAServerSolidWorksIsntSetUpForAsksFirst()
    {
        // Any web page can make a connect link: one for a server that isn't the team's would take your sign-in.
        var team = new Uri("https://lucazerega.tail07089c.ts.net/");
        var other = new Uri("https://vault.example.org/");
        var folder = Path.Combine(Path.GetTempPath(), "vault-connect-" + Guid.NewGuid().ToString("N"));
        try
        {
            // Not set up yet: even the team's own server is asked about, once, by its address.
            Assert.Contains("https://lucazerega.tail07089c.ts.net", OpenLink.ConnectQuestion(team, folder, lastServer: null), StringComparison.Ordinal);

            // Signed in to it before: its links go ahead, however its address is written; another's are asked about.
            Assert.Null(OpenLink.ConnectQuestion(new Uri("https://LUCAZEREGA.tail07089c.ts.net"), folder, team));
            var elsewhere = OpenLink.ConnectQuestion(other, folder, team);
            Assert.Contains("https://vault.example.org", elsewhere, StringComparison.Ordinal);
            Assert.Contains("set up for the one at https://lucazerega.tail07089c.ts.net", elsewhere, StringComparison.Ordinal);

            // The workspace folder says which server SolidWorks is set up for, whatever it signed in to last.
            Workspace.Create(folder, team, "token").Dispose();
            Assert.Null(OpenLink.ConnectQuestion(team, folder, other));
            Assert.NotNull(OpenLink.ConnectQuestion(other, folder, other));
        }
        finally
        {
            TempFolders.Delete(folder);
        }
    }

    [Fact]
    public void AServerThatIsntPrivateSaysSo()
    {
        Assert.Contains("not https", OpenLink.ConnectQuestion(new Uri("http://192.168.1.20:8000/"), Path.GetTempPath(), null), StringComparison.Ordinal);
        Assert.DoesNotContain("not https", OpenLink.ConnectQuestion(new Uri("https://vault.example.org/"), Path.GetTempPath(), null), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://lucazerega.tail07089c.ts.net/", "https://lucazerega.tail07089c.ts.net")]
    [InlineData("https://lucazerega.tаil07089c.ts.net/", "https://lucazerega.xn--til07089c-0yh.ts.net")] // a Cyrillic a: shown as it is
    [InlineData("https://Team.Example.org:8443/vault/", "https://team.example.org:8443/vault")]
    [InlineData("http://[::1]:8000/", "http://[::1]:8000")]
    public void AddressesShowWhereTheServerReallyIs(string server, string shown) =>
        Assert.Equal(shown, OpenLink.Address(new Uri(server)));
}
