using System.Globalization;
using System.Text.RegularExpressions;

namespace Vault.Client;

/// <summary>
/// Part numbers' names, as the server's vault/numbers.py has them (it has the last word, and the tests share its cases):
/// 00000123-001, eight digits the vault hands out in order and a kind, and then the end of the name, or a symbol or a
/// space before more, as a drawing named after its part has ("00000123-001 - machining.SLDDRW").
/// </summary>
public static class PartNumbers
{
    private static readonly Regex Numbered = new Regex(@"^([0-9]{8})-([0-9]{3})(?![0-9A-Za-z])", RegexOptions.CultureInvariant);

    // McMaster-Carr's part numbers, which their files are named by: 91251A463, "91251A463_Socket Head Screw".
    private static readonly Regex McMaster = new Regex(@"^[0-9]{4,5}[A-Za-z][0-9]{1,4}(?![0-9A-Za-z])", RegexOptions.CultureInvariant);

    // The files that take numbers of their own: parts, assemblies, and STEP and STL files we make.
    private static readonly string[] Holders = { ".sldprt", ".sldasm", ".step", ".stp", ".stl" };

    /// <summary>The part number a file's name starts with (00000123-001), and whether the name is that alone; null for none.</summary>
    public static (string Number, bool Exact)? NumberOf(string name)
    {
        var stem = Stem(name);
        var found = Numbered.Match(stem);
        return found.Success ? (found.Value, found.Length == stem.Length) : null;
    }

    /// <summary>Whether a file's type takes a number of its own: a part, an assembly, or a STEP or STL file.</summary>
    public static bool TakesANumber(string name) => Holders.Any(type => name.EndsWith(type, StringComparison.OrdinalIgnoreCase));

    /// <summary>Whether a file is named by a part number of its own (a part's, an assembly's), which never changes.</summary>
    public static bool KeepsItsName(string name) => NumberOf(name) != null && TakesANumber(name);

    /// <summary>Whether a file is named as a vendor names its parts (McMaster-Carr's numbers): such a file keeps its name.</summary>
    public static bool VendorsName(string name) => McMaster.IsMatch(Stem(name));

    /// <summary>How a part number is written: 00000123-001.</summary>
    public static string Text(long number, string kind) => number.ToString("D8", CultureInfo.InvariantCulture) + "-" + kind;

    // A name without its type, as the server's paths.stem has it.
    private static string Stem(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name.Substring(0, dot) : name;
    }
}
