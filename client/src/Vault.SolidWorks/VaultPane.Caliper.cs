using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Vault.Client;

namespace Vault.SolidWorks;

/// <summary>
/// Caliper's 3D models, which the web app shows parts and assemblies in, and drawings' PDFs, which it shows drawings
/// in: the add-in makes them, of what it checks in and (Make 3D view, Make PDF) of the active document, from what
/// SolidWorks has open. (The server reads a 3D model from the 3D view SolidWorks saved in a file only where a version
/// has none, and shows the pictures of a drawing's sheets SolidWorks saved in it where it has no PDF.)
/// </summary>
internal sealed partial class VaultPane
{
    /// <summary>Make 3D view: the active document's model, and those of what it uses, where they're missing.</summary>
    private Task MakeModelsHereAsync(string path) =>
        RunAsync("Making the 3D view", async workspace => await MakeModelsAsync(workspace, path));

    /// <summary>Make PDF: the active drawing's, if its version has none.</summary>
    private Task MakeDrawingPdfHereAsync(string path) =>
        RunAsync("Making the PDF", async workspace => await MakeDrawingPdfAsync(workspace, path));

    /// <summary>
    /// Make the PDF of an open drawing, of all its sheets, for Caliper, if its version (the vault's, here) has none yet.
    /// Says what it did, or why it didn't; it never throws, so a check-in before it stays done whatever happens here.
    /// </summary>
    private async Task<string> MakeDrawingPdfAsync(Workspace workspace, string path)
    {
        var name = Path.GetFileName(path);
        try
        {
            if (_sw.OpenDocument(path) == null)
            {
                return ""; // checked in without SolidWorks having it open: Make PDF makes it once it's open
            }
            var pdfs = new DrawingPdfs(workspace);
            var plan = await pdfs.PlanAsync(new[] { path });
            if (plan.Count == 0)
            {
                return plan.Problems.FirstOrDefault() ?? $"{name} has its PDF for Caliper already.";
            }
            ShowMessage($"Saving {name} as a PDF for Caliper...", Tone.Info);
            await Task.Yield(); // let the message show before SolidWorks is busy for a moment
            var (pdf, problem) = _sw.DrawingPdf(path);
            problem ??= await pdfs.SaveAsync(plan, path, pdf!);
            if (problem != null)
            {
                Log.Info("Drawing PDFs: " + problem);
                return problem;
            }
            return $"Made the PDF Caliper shows of {name}.";
        }
        catch (Exception e)
        {
            Log.Error("Making a drawing's PDF failed", e);
            return $"The PDF of {name} wasn't made: {Reason(e)}";
        }
    }

    /// <summary>
    /// Make the 3D models of an open part or assembly, and of the parts and sub-assemblies it uses, that have none yet:
    /// each of the vault version that's here. Says what it did, and why anything wasn't; it never throws, so a check-in
    /// before it stays done whatever happens here.
    /// </summary>
    private async Task<string> MakeModelsAsync(Workspace workspace, string path)
    {
        try
        {
            var read = _sw.ReadForCaliper(path);
            if (read == null)
            {
                return "";
            }
            var models = new CaliperModels(workspace);
            var plan = await models.PlanAsync(read.Wants());
            if (plan.Count == 0)
            {
                return plan.Problems.FirstOrDefault() ?? $"{Path.GetFileName(path)} has its 3D view already.";
            }
            ShowMessage($"Making {Count(plan.Count, "3D view")} for Caliper...", Tone.Info);
            await Task.Yield(); // let the message show before SolidWorks is busy for a moment
            var made = _sw.MakeCaliperModels(read, plan);
            var saved = await models.SaveAsync(plan, made.Parts, made.Assemblies);
            var problems = plan.Problems.Concat(made.Problems).Concat(saved.Problems).ToList();
            problems.ForEach(problem => Log.Info("3D views: " + problem));
            var summary = saved.Made > 0 ? $"Made {Count(saved.Made, "3D view")} for Caliper." : "Made no 3D views.";
            return problems.Count switch
            {
                0 => summary,
                1 => $"{summary} {problems[0]}",
                _ => $"{summary} {problems[0]} ({problems.Count - 1} more in {Log.FilePath})",
            };
        }
        catch (Exception e)
        {
            Log.Error("Making 3D views failed", e);
            return $"The 3D view wasn't made: {Reason(e)}";
        }
    }
}
