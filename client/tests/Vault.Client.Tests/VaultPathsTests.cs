namespace Vault.Client.Tests;

/// <summary>The same cases as server/tests/test_paths.py: client and server must agree on names.</summary>
public sealed class VaultPathsTests
{
    [Theory]
    [InlineData("Fin.SLDPRT")]
    [InlineData("Nose cone v2.SLDASM")]
    [InlineData("Ø-ring 38mm.STEP")]
    [InlineData(".gitignore")]
    [InlineData("Rev(A)")]
    public void ValidNames(string name) => Assert.Equal(name, VaultPaths.CleanName(name));

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("a:b")]
    [InlineData("what?.step")]
    [InlineData("quote\".x")]
    [InlineData("con")]
    [InlineData("CON.txt")]
    [InlineData("Lpt1.sldprt")]
    [InlineData("dot.")]
    [InlineData("space ")]
    [InlineData(" lead")]
    [InlineData("~$Fin.SLDPRT")]
    [InlineData("tab\there")]
    public void NamesWindowsRejects(string name) => Assert.Throws<VaultPathException>(() => VaultPaths.CleanName(name));

    [Fact]
    public void SplitAcceptsEitherSlashAndIgnoresExtras()
    {
        Assert.Equal(["Structures", "Fins"], VaultPaths.Split("\\Structures//Fins/"));
        Assert.Empty(VaultPaths.Split(""));
    }

    [Fact]
    public void NamesNormalizeToNfc()
    {
        const string decomposed = "Me\u0301canique.STEP"; // macOS spells é as e + combining accent
        Assert.Equal("M\u00e9canique.STEP", VaultPaths.CleanName(decomposed));
        Assert.Equal(VaultPaths.Key("m\u00e9canique.step"), VaultPaths.Key(decomposed));
    }

    [Fact]
    public void PathLengthLimit()
    {
        VaultPaths.Split(string.Join("/", Enumerable.Repeat("aaaaaaaaa", 20))); // 199 characters
        Assert.Throws<VaultPathException>(() => VaultPaths.Split(string.Join("/", Enumerable.Repeat("aaaaaaaaa", 21))));
    }

    [Fact]
    public void NamesThatArentUnicodeTextAreRejected() =>
        Assert.Throws<VaultPathException>(() => VaultPaths.CleanName("Fin\ud800.STEP")); // half a character

    // Client only: how a client takes paths from the server (see Workspace.ToLocalPath).
    [Fact]
    public void ServerPathsAreNamesJoinedBySlashes()
    {
        Assert.Equal(["Structures", "Fins", "Fin.SLDPRT"], VaultPaths.SplitServerPath("Structures/Fins/Fin.SLDPRT"));
        Assert.Empty(VaultPaths.SplitServerPath(""));
        Assert.Equal(21, VaultPaths.SplitServerPath(string.Join("/", Enumerable.Repeat("aaaaaaaaa", 21))).Count); // longer than MaxPath
    }

    [Theory]
    [InlineData("/Fins")]
    [InlineData("Fins/")]
    [InlineData("Fins//Fin.SLDPRT")]
    [InlineData("Fins\\Fin.SLDPRT")]
    [InlineData("../Fin.SLDPRT")]
    [InlineData("C:/Fin.SLDPRT")]
    public void ServerPathsInAnyOtherFormAreRejected(string path) =>
        Assert.Throws<VaultPathException>(() => VaultPaths.SplitServerPath(path));

    [Theory]
    [InlineData("~$Fin Can.SLDASM", true)]
    [InlineData("Thumbs.db", true)]
    [InlineData(".DS_Store", true)]
    [InlineData("scratch.TMP", true)]
    [InlineData("Fin.SLDPRT.vault-download", true)]
    [InlineData("Fin.SLDPRT", false)]
    public void IgnoredFiles(string name, bool ignored) => Assert.Equal(ignored, VaultPaths.IsIgnored(name));
}
