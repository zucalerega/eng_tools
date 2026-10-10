using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Vault.Client;

namespace Vault.SolidWorks;

/// <summary>
/// Caliper's 3D models, which the web app shows parts and assemblies in: only SolidWorks can read SolidWorks files, so
/// the add-in makes them, of what it checks in and (Make 3D view) of the active document, from what SolidWorks has open.
/// </summary>
internal sealed partial class VaultPane
{
    /// <summary>Make 3D view: the active document's model, and those of what it uses, where they're missing.</summary>
    private Task MakeModelsHereAsync(string path) =>
        RunAsync("Making the 3D view", async workspace => await MakeModelsAsync(workspace, path));

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
