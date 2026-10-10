namespace Vault.Client;

/// <summary>A part's 3D model for Caliper: its file here, the configuration it's of, its document's units, its mesh.</summary>
public sealed class CaliperPart
{
    public CaliperPart(string localPath, string configuration, string units, CaliperMesh mesh)
    {
        (LocalPath, Configuration, Units, Mesh) = (localPath, configuration, units, mesh);
    }

    public string LocalPath { get; }

    public string Configuration { get; }

    public string Units { get; }

    public CaliperMesh Mesh { get; }
}

/// <summary>An assembly's 3D model for Caliper: its file here, the configuration it's of, its units, its components.</summary>
public sealed class CaliperAssembly
{
    public CaliperAssembly(string localPath, string configuration, string units, IReadOnlyList<CaliperComponent> components)
    {
        (LocalPath, Configuration, Units, Components) = (localPath, configuration, units, components);
    }

    public string LocalPath { get; }

    public string Configuration { get; }

    public string Units { get; }

    public IReadOnlyList<CaliperComponent> Components { get; }
}

/// <summary>
/// A component of an assembly, as SolidWorks has it: a part or sub-assembly (its file here, in a configuration), or a
/// virtual part, which the assembly keeps (its own mesh); where it is, whether it's hidden, its color over its part's.
/// </summary>
public sealed class CaliperComponent
{
    public string Name { get; set; } = "";

    /// <summary>Its file here; null for a virtual part, which has none.</summary>
    public string? LocalPath { get; set; }

    public string Configuration { get; set; } = "";

    /// <summary>Where it is: the rows of a 3 x 4 matrix to the top assembly's coordinates, in mm (see CaliperTransforms).</summary>
    public double[] Transform { get; set; } = CaliperTransforms.Identity;

    public bool Hidden { get; set; }

    public CaliperColor? Color { get; set; }

    /// <summary>A virtual part's shape.</summary>
    public CaliperMesh? Mesh { get; set; }

    /// <summary>A sub-assembly's components, placed in the same coordinates.</summary>
    public List<CaliperComponent> Children { get; } = new List<CaliperComponent>();
}

/// <summary>Where components are, as Caliper keeps it: the rows of a 3 x 4 matrix, rotation then translation in mm.</summary>
public static class CaliperTransforms
{
    public static readonly double[] Identity = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 };

    /// <summary>
    /// A component's transform from SolidWorks' (IComponent2.Transform2's ArrayData: the rotation by columns, then the
    /// translation in meters, then a scale), to the top assembly's coordinates.
    /// </summary>
    public static double[] FromSolidWorks(double[] data)
    {
        if (data.Length < 13)
        {
            throw new ArgumentException("A SolidWorks transform has 16 numbers", nameof(data));
        }
        var scale = data[12] == 0 ? 1 : data[12];
        var rows = new double[12];
        for (var i = 0; i < 3; i++)
        {
            for (var j = 0; j < 3; j++)
            {
                rows[(4 * i) + j] = data[(3 * j) + i] * scale;
            }
            rows[(4 * i) + 3] = data[9 + i] * 1000;
        }
        return rows;
    }

    /// <summary>
    /// Where a component is in a sub-assembly, from where both are in the top assembly: for the sub-assembly's own
    /// model, as SolidWorks places every component relative to the top. (The inverse of a turn is its transpose.)
    /// </summary>
    public static double[] Relative(double[] parent, double[] child)
    {
        var rows = new double[12];
        for (var i = 0; i < 3; i++)
        {
            for (var j = 0; j < 3; j++)
            {
                for (var k = 0; k < 3; k++)
                {
                    rows[(4 * i) + j] += parent[(4 * k) + i] * child[(4 * k) + j];
                }
            }
            for (var k = 0; k < 3; k++)
            {
                rows[(4 * i) + 3] += parent[(4 * k) + i] * (child[(4 * k) + 3] - parent[(4 * k) + 3]);
            }
        }
        return rows;
    }
}

/// <summary>The length units Caliper measures in, from a SolidWorks document's.</summary>
public static class CaliperUnits
{
    /// <summary>A document's length unit (swLengthUnit_e) as Caliper's: mm, cm, m, in, or ft.</summary>
    public static string FromSolidWorks(int unit) => unit switch
    {
        1 => "cm",
        2 => "m",
        3 or 5 or 9 or 10 => "in", // inches; feet and inches; mils; microinches
        4 => "ft",
        _ => "mm", // millimeters, and the small units: angstroms, nanometers, microns
    };
}

/// <summary>A file here, in a configuration, that a 3D model is wanted of. Always: whether or not it has one.</summary>
public sealed class CaliperWant
{
    public CaliperWant(string localPath, string configuration, bool always = false)
    {
        (LocalPath, Configuration, Always) = (localPath, configuration, always);
    }

    public string LocalPath { get; }

    public string Configuration { get; }

    public bool Always { get; }
}

/// <summary>Which 3D models to make, and the vault versions of the files they're of.</summary>
public sealed class CaliperPlan
{
    internal Dictionary<string, (long FileId, int Version)> Versions { get; } = new Dictionary<string, (long, int)>(StringComparer.Ordinal);

    internal HashSet<(string Key, string Configuration)> Needed { get; } = new HashSet<(string, string)>();

    /// <summary>Files there can be no model of, and why: changed here, or not in the vault yet.</summary>
    public List<string> Problems { get; } = new List<string>();

    /// <summary>How many models to make.</summary>
    public int Count => Needed.Count;

    /// <summary>Whether to make the model of this file here, in this configuration.</summary>
    public bool Needs(string localPath, string configuration) => Needed.Contains((Key(localPath), configuration));

    // Local paths are compared as Windows does: case doesn't matter.
    internal static string Key(string localPath) => Path.GetFullPath(localPath).ToUpperInvariant();
}

/// <summary>What saving 3D models did.</summary>
public sealed class CaliperSaved
{
    public int Made { get; internal set; }

    /// <summary>What couldn't be saved, or was left out, and why.</summary>
    public List<string> Problems { get; } = new List<string>();
}

/// <summary>
/// Caliper's 3D models of files here, made in SolidWorks by the add-in: which ones to make (each of a vault version,
/// unchanged here, that has no model yet), and saving them. The add-in reads SolidWorks; this is everything else.
/// </summary>
public sealed class CaliperModels
{
    private readonly Workspace _workspace;

    public CaliperModels(Workspace workspace) => _workspace = workspace;

    /// <summary>
    /// Which of these models to make: each file must be here as a version of the vault, unchanged, and that version
    /// must have no model in that configuration yet (unless it's wanted always). The plan keeps every file's version,
    /// for the assemblies that use them.
    /// </summary>
    public async Task<CaliperPlan> PlanAsync(IEnumerable<CaliperWant> wanted, CancellationToken ct = default)
    {
        var plan = new CaliperPlan();
        var wants = wanted.ToList();
        var paths = wants.Select(w => w.LocalPath).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (paths.Count == 0)
        {
            return plan;
        }
        var byKey = (await _workspace.StatusAsync(paths, ct).ConfigureAwait(false))
            .GroupBy(s => Key(s.LocalPath))
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var path in paths)
        {
            var name = Path.GetFileName(path);
            if (!byKey.TryGetValue(Key(path), out var status))
            {
                plan.Problems.Add($"{name} isn't in the workspace, so it has no 3D model.");
                continue;
            }
            switch (status.State)
            {
                case FileState.UpToDate or FileState.Outdated when status.FileId is { } id && status.LocalVersion is { } version:
                    plan.Versions[Key(path)] = (id, version);
                    break;
                case FileState.New:
                    plan.Problems.Add($"{name} isn't in the vault yet: it gets a 3D model when it's checked in.");
                    break;
                case FileState.Modified or FileState.Conflict:
                    plan.Problems.Add($"{name} is changed here and not checked in: it gets a 3D model when it is.");
                    break;
                default:
                    plan.Problems.Add($"{name} isn't a version of the vault here, so it has no 3D model.");
                    break;
            }
        }

        var asked = new List<CaliperModelKey>();
        foreach (var want in wants)
        {
            if (!plan.Versions.TryGetValue(Key(want.LocalPath), out var at))
            {
                continue;
            }
            if (want.Always)
            {
                plan.Needed.Add((Key(want.LocalPath), want.Configuration));
            }
            else
            {
                asked.Add(new CaliperModelKey { FileId = at.FileId, Version = at.Version, Configuration = want.Configuration });
            }
        }
        if (asked.Count > 0)
        {
            var missing = await _workspace.Api.MissingCaliperModelsAsync(asked, ct).ConfigureAwait(false);
            var pathOf = plan.Versions.ToDictionary(p => p.Value, p => p.Key);
            foreach (var model in missing)
            {
                if (pathOf.TryGetValue((model.FileId, model.Version), out var key))
                {
                    plan.Needed.Add((key, model.Configuration));
                }
            }
        }
        return plan;
    }

    /// <summary>
    /// Save models made by the plan: each mesh uploaded if the server doesn't have it, then each model. An assembly's
    /// components are its files' versions; one that isn't a version of the vault is left out, and said. A model that
    /// can't be saved doesn't stop the rest.
    /// </summary>
    public async Task<CaliperSaved> SaveAsync(
        CaliperPlan plan,
        IEnumerable<CaliperPart> parts,
        IEnumerable<CaliperAssembly> assemblies,
        CancellationToken ct = default)
    {
        var saved = new CaliperSaved();
        foreach (var part in parts)
        {
            await SaveOneAsync(plan, saved, part.LocalPath, async at => new CaliperModelRequest
            {
                Version = at.Version,
                Configuration = part.Configuration,
                Units = part.Units,
                Mesh = await UploadAsync(part.Mesh, ct).ConfigureAwait(false),
            }, ct).ConfigureAwait(false);
        }
        foreach (var assembly in assemblies)
        {
            var name = Path.GetFileName(assembly.LocalPath);
            await SaveOneAsync(plan, saved, assembly.LocalPath, async at => new CaliperModelRequest
            {
                Version = at.Version,
                Configuration = assembly.Configuration,
                Units = assembly.Units,
                Components = await ComponentsAsync(plan, saved, name, assembly.Components, ct).ConfigureAwait(false),
            }, ct).ConfigureAwait(false);
        }
        return saved;
    }

    private async Task SaveOneAsync(
        CaliperPlan plan,
        CaliperSaved saved,
        string localPath,
        Func<(long FileId, int Version), Task<CaliperModelRequest>> request,
        CancellationToken ct)
    {
        if (!plan.Versions.TryGetValue(Key(localPath), out var at))
        {
            return; // the plan said why
        }
        try
        {
            await _workspace.Api.PutCaliperModelAsync(at.FileId, await request(at).ConfigureAwait(false), ct).ConfigureAwait(false);
            saved.Made++;
        }
        catch (VaultApiException e)
        {
            saved.Problems.Add($"{Path.GetFileName(localPath)}'s 3D model wasn't saved: {e.Message}");
        }
    }

    private async Task<List<CaliperComponentRequest>> ComponentsAsync(
        CaliperPlan plan,
        CaliperSaved saved,
        string assembly,
        IEnumerable<CaliperComponent> components,
        CancellationToken ct)
    {
        var requests = new List<CaliperComponentRequest>();
        foreach (var component in components)
        {
            var request = new CaliperComponentRequest
            {
                Name = component.Name,
                Configuration = component.Configuration,
                Transform = component.Transform,
                Hidden = component.Hidden,
                Color = component.Color is { } color ? new[] { color.Red, color.Green, color.Blue } : null,
                Opacity = component.Color?.Opacity ?? 1,
                Children = await ComponentsAsync(plan, saved, assembly, component.Children, ct).ConfigureAwait(false),
            };
            if (component.LocalPath != null)
            {
                if (!plan.Versions.TryGetValue(Key(component.LocalPath), out var at))
                {
                    saved.Problems.Add($"{component.Name} is left out of {assembly}'s 3D model: {Path.GetFileName(component.LocalPath)} isn't a version of the vault here.");
                    continue;
                }
                (request.FileId, request.Version) = (at.FileId, at.Version);
            }
            if (component.Mesh != null)
            {
                request.Mesh = await UploadAsync(component.Mesh, ct).ConfigureAwait(false);
            }
            if (request.FileId == null && request.Mesh == null && request.Children.Count == 0)
            {
                continue; // a virtual part SolidWorks gave no shape: nothing to show
            }
            requests.Add(request);
        }
        return requests;
    }

    /// <summary>Upload a mesh (if the server doesn't have it already), and give its SHA-256.</summary>
    private async Task<string> UploadAsync(CaliperMesh mesh, CancellationToken ct)
    {
        var bytes = mesh.ToArray();
        var sha256 = Hashing.Sha256(bytes);
        if (!await _workspace.Api.HasBlobAsync(sha256, ct).ConfigureAwait(false))
        {
            using var content = new MemoryStream(bytes, writable: false);
            await _workspace.Api.UploadBlobAsync(sha256, content, ct).ConfigureAwait(false);
        }
        return sha256;
    }

    private static string Key(string localPath) => CaliperPlan.Key(localPath);
}
