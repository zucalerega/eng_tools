namespace Vault.Client;

/// <summary>Which drawings to make PDFs of, and the vault versions they're of.</summary>
public sealed class DrawingPdfPlan
{
    internal Dictionary<string, (long FileId, int Version)> Versions { get; } = new Dictionary<string, (long, int)>(StringComparer.Ordinal);

    internal HashSet<string> Needed { get; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Drawings there can be no PDF of, and why: changed here, or not in the vault yet.</summary>
    public List<string> Problems { get; } = new List<string>();

    /// <summary>How many PDFs to make.</summary>
    public int Count => Needed.Count;

    /// <summary>Whether to make the PDF of this drawing here.</summary>
    public bool Needs(string localPath) => Needed.Contains(CaliperPlan.Key(localPath));
}

/// <summary>
/// The PDFs of drawings here that Caliper shows in the web app, of all their sheets, saved from SolidWorks by the
/// add-in: which to make (each of a vault version, unchanged here, that has none yet), and saving them. The add-in
/// saves the PDF in SolidWorks; this is everything else.
/// </summary>
public sealed class DrawingPdfs
{
    private readonly Workspace _workspace;

    public DrawingPdfs(Workspace workspace) => _workspace = workspace;

    /// <summary>Whether a file is a SolidWorks drawing, which has a PDF.</summary>
    public static bool IsDrawing(string path) => Path.GetExtension(path).Equals(".slddrw", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Which of these drawings to make PDFs of: each must be here as a version of the vault, unchanged, and that
    /// version must have no PDF yet.
    /// </summary>
    public async Task<DrawingPdfPlan> PlanAsync(IEnumerable<string> drawings, CancellationToken ct = default)
    {
        var plan = new DrawingPdfPlan();
        var paths = drawings.Where(IsDrawing).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (paths.Count == 0)
        {
            return plan;
        }
        var byKey = (await _workspace.StatusAsync(paths, ct).ConfigureAwait(false))
            .GroupBy(s => CaliperPlan.Key(s.LocalPath))
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var path in paths)
        {
            var name = Path.GetFileName(path);
            if (!byKey.TryGetValue(CaliperPlan.Key(path), out var status))
            {
                plan.Problems.Add($"{name} isn't in the workspace, so it has no PDF.");
                continue;
            }
            switch (status.State)
            {
                case FileState.UpToDate or FileState.Outdated when status.FileId is { } id && status.LocalVersion is { } version:
                    plan.Versions[CaliperPlan.Key(path)] = (id, version);
                    break;
                case FileState.New:
                    plan.Problems.Add($"{name} isn't in the vault yet: it gets its PDF when it's checked in.");
                    break;
                case FileState.Modified or FileState.Conflict:
                    plan.Problems.Add($"{name} is changed here and not checked in: it gets its PDF when it is.");
                    break;
                default:
                    plan.Problems.Add($"{name} isn't a version of the vault here, so it has no PDF.");
                    break;
            }
        }
        if (plan.Versions.Count > 0)
        {
            var asked = plan.Versions.Values.Select(v => new DrawingKey { FileId = v.FileId, Version = v.Version }).ToList();
            var missing = await _workspace.Api.MissingDrawingPdfsAsync(asked, ct).ConfigureAwait(false);
            var pathOf = plan.Versions.ToDictionary(p => p.Value, p => p.Key);
            foreach (var drawing in missing)
            {
                if (pathOf.TryGetValue((drawing.FileId, drawing.Version), out var key))
                {
                    plan.Needed.Add(key);
                }
            }
        }
        return plan;
    }

    /// <summary>
    /// Save a drawing's PDF made by the plan, as its version's: uploaded if the server doesn't have it, then saved. Says
    /// why not, if it wasn't saved; null if it was.
    /// </summary>
    public async Task<string?> SaveAsync(DrawingPdfPlan plan, string localPath, byte[] pdf, CancellationToken ct = default)
    {
        if (!plan.Versions.TryGetValue(CaliperPlan.Key(localPath), out var at))
        {
            return $"{Path.GetFileName(localPath)} isn't a version of the vault here, so its PDF wasn't saved.";
        }
        try
        {
            var sha256 = Hashing.Sha256(pdf);
            if (!await _workspace.Api.HasBlobAsync(sha256, ct).ConfigureAwait(false))
            {
                using var content = new MemoryStream(pdf, writable: false);
                await _workspace.Api.UploadBlobAsync(sha256, content, ct).ConfigureAwait(false);
            }
            await _workspace.Api.PutDrawingPdfAsync(at.FileId, new DrawingPdfRequest { Version = at.Version, Pdf = sha256 }, ct).ConfigureAwait(false);
            return null;
        }
        catch (VaultApiException e)
        {
            return $"{Path.GetFileName(localPath)}'s PDF wasn't saved: {e.Message}";
        }
    }
}
