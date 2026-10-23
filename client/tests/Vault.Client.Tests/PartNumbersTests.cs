namespace Vault.Client.Tests;

/// <summary>The same cases as server/tests/test_numbers.py (and the web app's paths.test.ts): they must agree on part numbers.</summary>
public sealed class PartNumbersTests
{
    [Theory]
    [InlineData("00000123-001.SLDPRT", "00000123-001", true)]
    [InlineData("00000123-501.sldasm", "00000123-501", true)]
    [InlineData("00000123-001", "00000123-001", true)]
    [InlineData("00000123-001 - machining.SLDDRW", "00000123-001", false)]
    [InlineData("00000123-001.PDF", "00000123-001", true)]
    [InlineData("00000004-010-6.SLDPRT", "00000004-010", false)]
    [InlineData("00000004-501 downloads backup.SLDASM", "00000004-501", false)]
    [InlineData("99999999-999.STEP", "99999999-999", true)]
    public void NamesThatArePartNumbers(string name, string number, bool exact) =>
        Assert.Equal((number, exact), PartNumbers.NumberOf(name));

    [Theory]
    [InlineData("Fin.SLDPRT")]
    [InlineData("0000123-001.SLDPRT")]
    [InlineData("000000123-001.SLDPRT")]
    [InlineData("00000123-01.SLDPRT")]
    [InlineData("00000123-0011.SLDPRT")]
    [InlineData("00000123-001a.SLDPRT")]
    [InlineData("00000123_001.SLDPRT")]
    [InlineData("91251A463_Socket Head Screw.SLDPRT")]
    [InlineData("1341617 VUVS-L20-COVER CAP.SLDPRT")]
    public void NamesThatArent(string name) => Assert.Null(PartNumbers.NumberOf(name));

    [Fact]
    public void PartsAssembliesAndStepAndStlFilesKeepTheirNumbers()
    {
        Assert.All(["00000123-001.SLDPRT", "00000123-501.SLDASM", "00000123-001.STEP", "00000123-001.stl"], name => Assert.True(PartNumbers.KeepsItsName(name)));
        Assert.All(["00000123-001.SLDDRW", "00000123-001.PDF", "Fin.SLDPRT"], name => Assert.False(PartNumbers.KeepsItsName(name)));
    }

    [Theory]
    [InlineData("91251A463.SLDPRT", true)]
    [InlineData("91251A463_Socket Head Screw.SLDPRT", true)]
    [InlineData("5911K12 Ball Valve.SLDASM", true)]
    [InlineData("90107a029.STEP", true)]
    [InlineData("Fin.SLDPRT", false)]
    [InlineData("00000123-001.SLDPRT", false)]
    [InlineData("91251A463B.SLDPRT", false)]
    [InlineData("102423 Stringer.SLDPRT", false)]
    public void VendorsNames(string name, bool vendor) => Assert.Equal(vendor, PartNumbers.VendorsName(name));

    [Fact]
    public void HowNumbersAreWritten() => Assert.Equal("00000123-001", PartNumbers.Text(123, "001"));

    [Theory]
    [InlineData("00000123-001.SLDPRT", "Fin bracket", "Fin bracket")] // a part number says nothing of what it is
    [InlineData("Fin.SLDPRT", "Fin, left side", "Fin, left side")] // someone named it
    [InlineData("Fin.SLDPRT", "Fin", null)] // as every file's title starts out: not said twice
    [InlineData("Fin.SLDPRT", "fin", null)]
    [InlineData("README", "README", null)]
    [InlineData("Fin.SLDPRT", null, null)] // a server from before titles
    public void ATitleIsShownWhereItSaysMoreThanTheName(string name, string? title, string? shown) =>
        Assert.Equal(shown, Titles.Beside(name, title));
}
