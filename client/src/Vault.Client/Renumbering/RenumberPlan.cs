using System.Globalization;
using System.Text;

namespace Vault.Client.Renumbering;

// Numbering the vault's files all at once (docs/renumbering.md): which file gets which name. A pure function of a
// snapshot of the vault, the lists the leads reviewed, and the first number handed out, so a rehearsal and the run
// make the same plan from the same inputs. The SolidWorks side (rewriting what assemblies and drawings name) and the
// check-in follow it.

/// <summary>A live file in the vault, as the plan sees it.</summary>
public sealed class RenumberFile
{
    public RenumberFile(long id, string path, string? title = null, bool vendor = false, IReadOnlyList<long>? uses = null)
    {
        Id = id;
        Path = path;
        Title = title ?? Stem(path.Substring(path.LastIndexOf('/') + 1));
        Vendor = vendor;
        Uses = uses ?? Array.Empty<long>();
    }

    public long Id { get; }

    public string Path { get; }

    public string Title { get; }

    /// <summary>Marked a vendor's part in the vault.</summary>
    public bool Vendor { get; }

    /// <summary>What its latest version uses, by id: a drawing's model, an assembly's parts.</summary>
    public IReadOnlyList<long> Uses { get; }

    internal string Name => Path.Substring(Path.LastIndexOf('/') + 1);

    internal string Folder => Path.Substring(0, Math.Max(0, Path.LastIndexOf('/')));

    internal static string Stem(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name.Substring(0, dot) : name;
    }
}

/// <summary>What the leads reviewed: vendors' parts, titles, and the kinds each folder's parts and assemblies take.</summary>
public sealed class RenumberRules
{
    /// <summary>Paths of files that keep their names as vendors' parts, besides those the vault or McMaster's numbers say are.</summary>
    public ISet<string> Vendors { get; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Paths that keep their names though they're no vendor's: say why in the review.</summary>
    public ISet<string> Keep { get; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Titles to give, by path key, over the title each file has.</summary>
    public IDictionary<string, string> Titles { get; } = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>The kinds a folder's parts and assemblies take, by folder path key, for it and the folders in it.</summary>
    public IDictionary<string, (string Part, string Assembly)> FolderKinds { get; } = new Dictionary<string, (string, string)>(StringComparer.Ordinal);

    /// <summary>The kinds files take where no folder says: the generic ones.</summary>
    public string PartKind { get; set; } = "001";

    public string AssemblyKind { get; set; } = "501";

    internal (string Part, string Assembly) KindsFor(string folder)
    {
        for (var key = VaultPaths.Key(folder); ; key = key.Substring(0, Math.Max(0, key.LastIndexOf('/'))))
        {
            if (FolderKinds.TryGetValue(key, out var kinds))
            {
                return kinds;
            }
            if (key.Length == 0)
            {
                return (PartKind, AssemblyKind);
            }
        }
    }
}

/// <summary>A file the plan renames: a part or assembly, to its number; a drawing, PDF, or export, after its model's.</summary>
public sealed class RenumberEntry
{
    internal RenumberEntry(RenumberFile file, string newName, string number, string kind, string title, string role)
    {
        File = file;
        NewName = newName;
        Number = number;
        Kind = kind;
        Title = title;
        Role = role;
    }

    public RenumberFile File { get; }

    public string NewName { get; }

    /// <summary>The part number it's named by: its own (a part's, an assembly's), or its model's.</summary>
    public string Number { get; }

    public string Kind { get; }

    public string Title { get; }

    /// <summary>"part", "assembly", or what it's named after: "drawing of Fins/Fin.SLDPRT", "named after ...".</summary>
    public string Role { get; }

    public string NewPath => File.Folder.Length > 0 ? File.Folder + "/" + NewName : NewName;
}

/// <summary>Which file gets which name (Plan), what keeps its name and why, and what stops the run.</summary>
public sealed class RenumberPlan
{
    internal RenumberPlan(long first, long next, List<RenumberEntry> renames, List<(RenumberFile File, string Why)> kept, List<string> problems)
    {
        FirstNumber = first;
        NextNumber = next;
        Renames = renames;
        Kept = kept;
        Problems = problems;
    }

    public long FirstNumber { get; }

    /// <summary>The number after the last the plan uses: the run hands out FirstNumber up to here.</summary>
    public long NextNumber { get; }

    public IReadOnlyList<RenumberEntry> Renames { get; }

    /// <summary>The SolidWorks files keeping their names, and why: a vendor's, numbered already, or said so in the review.</summary>
    public IReadOnlyList<(RenumberFile File, string Why)> Kept { get; }

    /// <summary>What has to be settled before the run: the review, or the vault.</summary>
    public IReadOnlyList<string> Problems { get; }

    /// <summary>The vault's live files, as a workspace's last refresh has them, with what each uses: the plan's snapshot.</summary>
    public static IReadOnlyList<RenumberFile> FilesOf(VaultTree vault) =>
        vault.Files.Where(f => f.FileId != null)
            .Select(f => new RenumberFile(f.FileId!.Value, f.VaultPath, f.Title, f.Vendor, (vault.Uses(f) ?? Array.Empty<UsedStatus>()).Select(u => u.FileId).ToList()))
            .ToList();

    // Parts and assemblies take numbers; drawings and these, named after a model, take its number.
    private static readonly string[] Models = { ".sldprt", ".sldasm" };
    private static readonly string[] Derived = { ".slddrw", ".pdf", ".step", ".stp", ".stl", ".dxf", ".dwg", ".x_t", ".igs", ".iges" };

    /// <summary>
    /// The plan: the vault's live parts and assemblies, but vendors' parts (the vault's flag, McMaster's numbers, or the
    /// review's list) and files named by part numbers already (Ground Structures'), take numbers from first, in order
    /// of their folders, then assemblies before parts, then names, then ids, with the kinds their folders take and the
    /// titles they have (or the review gives). Drawings, PDFs, and exports named after one of them, in its folder, are
    /// named after its number, with what came after the model's name kept: "Fin - machining.SLDDRW" to
    /// "00000123-001 - machining.SLDDRW". A drawing goes with the model it shows, where the vault knows.
    /// </summary>
    public static RenumberPlan Plan(IEnumerable<RenumberFile> files, RenumberRules rules, long first)
    {
        var all = files.ToList();
        var problems = new List<string>();
        var kept = new List<(RenumberFile, string)>();
        var models = new List<RenumberFile>();
        foreach (var file in all.Where(f => Models.Any(type => f.Name.EndsWith(type, StringComparison.OrdinalIgnoreCase))))
        {
            var key = VaultPaths.Key(file.Path);
            var why = PartNumbers.NumberOf(file.Name) != null ? "named by a part number already"
                : file.Vendor || rules.Vendors.Contains(key) || PartNumbers.VendorsName(file.Name) ? "a vendor's part"
                : rules.Keep.Contains(key) ? "kept, as the review says"
                : null;
            if (why != null)
            {
                kept.Add((file, why));
            }
            else
            {
                models.Add(file);
            }
        }
        models.Sort(Order);

        var renames = new List<RenumberEntry>();
        var number = first;
        var byModel = new Dictionary<long, RenumberEntry>();
        foreach (var file in models)
        {
            var assembly = file.Name.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase);
            var kinds = rules.KindsFor(file.Folder);
            var kind = assembly ? kinds.Assembly : kinds.Part;
            if (!PartNumbers.IsKind(kind))
            {
                problems.Add($"{file.Folder}: {kind} isn't a kind of part number (three digits, like 001)");
            }
            var text = PartNumbers.Text(number++, kind);
            var title = rules.Titles.TryGetValue(VaultPaths.Key(file.Path), out var given) ? given : file.Title;
            var entry = new RenumberEntry(file, text + Extension(file.Name), text, kind, title, assembly ? "assembly" : "part");
            renames.Add(entry);
            byModel[file.Id] = entry;
        }

        // What's named after a renamed model takes its number: the one it shows, else the one in its folder whose name
        // it starts with, the longest (Fin Can before Fin).
        var inFolder = renames.ToLookup(entry => VaultPaths.Key(entry.File.Folder), StringComparer.Ordinal);
        foreach (var file in all.Where(f => Derived.Any(type => f.Name.EndsWith(type, StringComparison.OrdinalIgnoreCase))))
        {
            if (PartNumbers.NumberOf(file.Name) != null)
            {
                continue; // named after a number already
            }
            var shows = file.Uses.Where(byModel.ContainsKey).Select(id => byModel[id]).Where(m => NamedAfter(file.Name, m.File.Name)).ToList();
            var model = shows.Count > 0
                ? shows.OrderByDescending(m => m.File.Name.Length).First()
                : inFolder[VaultPaths.Key(file.Folder)].Where(m => NamedAfter(file.Name, m.File.Name)).OrderByDescending(m => m.File.Name.Length).FirstOrDefault();
            if (model == null)
            {
                if (VaultTree.IsDrawing(file.Path) && file.Uses.Any(byModel.ContainsKey))
                {
                    problems.Add($"{file.Path} shows a part being numbered, but isn't named after it: name it after what it shows");
                }
                continue;
            }
            var rest = RenumberFile.Stem(file.Name).Substring(RenumberFile.Stem(model.File.Name).Length);
            var role = (VaultTree.IsDrawing(file.Path) ? "drawing of " : "named after ") + model.File.Path;
            renames.Add(new RenumberEntry(file, model.Number + rest + Extension(file.Name), model.Number, model.Kind, file.Title, role));
        }

        // No two files may end up with one name in a folder, nor with that of a file that keeps its own.
        var renamed = new HashSet<long>(renames.Select(r => r.File.Id));
        var taken = all.Where(f => !renamed.Contains(f.Id)).Select(f => VaultPaths.Key(f.Path)).ToList();
        foreach (var clash in renames.Select(r => VaultPaths.Key(r.NewPath)).Concat(taken).GroupBy(key => key).Where(g => g.Count() > 1))
        {
            problems.Add($"Two files would be named {clash.Key}");
        }
        return new RenumberPlan(first, number, renames, kept, problems);
    }

    /// <summary>What a person reads before the run: what changes, what doesn't and why, and what's in the way.</summary>
    public string Report()
    {
        var text = new StringBuilder();
        var numbered = Renames.Count(r => r.Role is "part" or "assembly");
        text.AppendLine(string.Format(
            CultureInfo.InvariantCulture,
            "{0} parts and assemblies take numbers {1} to {2}; {3} drawings, PDFs, and exports take their models'.",
            numbered,
            PartNumbers.Digits(FirstNumber),
            PartNumbers.Digits(Math.Max(FirstNumber, NextNumber - 1)),
            Renames.Count - numbered));
        foreach (var why in Kept.GroupBy(k => k.Why).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            text.AppendLine(string.Format(CultureInfo.InvariantCulture, "{0} keep their names: {1}.", why.Count(), why.Key));
        }
        text.AppendLine(Problems.Count == 0 ? "Nothing is in the way." : $"{Problems.Count} to settle first:");
        foreach (var problem in Problems)
        {
            text.Append("  ").AppendLine(problem);
        }
        return text.ToString();
    }

    // By folder, then assemblies before parts, then name, then id: the order numbers are handed out in.
    private static int Order(RenumberFile a, RenumberFile b)
    {
        var folder = string.CompareOrdinal(VaultPaths.Key(a.Folder), VaultPaths.Key(b.Folder));
        if (folder != 0)
        {
            return folder;
        }
        var kind = IsPart(a).CompareTo(IsPart(b));
        if (kind != 0)
        {
            return kind;
        }
        var name = string.CompareOrdinal(VaultPaths.Key(a.Name), VaultPaths.Key(b.Name));
        return name != 0 ? name : a.Id.CompareTo(b.Id);
    }

    private static bool IsPart(RenumberFile file) => file.Name.EndsWith(".sldprt", StringComparison.OrdinalIgnoreCase);

    private static string Extension(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name.Substring(dot) : "";
    }

    // As the server's paths.named_after: a drawing's name is its model's, or starts with it and goes on after a space
    // or a symbol, so Fin2 and Finish aren't Fin's.
    internal static bool NamedAfter(string name, string model)
    {
        var stem = VaultPaths.Key(RenumberFile.Stem(name));
        var basis = VaultPaths.Key(RenumberFile.Stem(model));
        return stem == basis || (stem.StartsWith(basis, StringComparison.Ordinal) && !char.IsLetterOrDigit(stem[basis.Length]));
    }
}
