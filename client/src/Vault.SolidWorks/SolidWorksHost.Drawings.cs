using System;
using System.IO;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Vault.SolidWorks;

/// <summary>
/// What Caliper needs from SolidWorks of a drawing: its sheets, every one, as a PDF, as File > Save As > PDF saves them.
/// Which drawings to make PDFs of, and saving them, is Vault.Client's (DrawingPdfs). Call only on SolidWorks' main
/// thread.
/// </summary>
internal sealed partial class SolidWorksHost
{
    /// <summary>
    /// An open drawing's sheets as a PDF; or null and why not: it isn't open, it has changes that aren't saved (so it
    /// isn't the version that's here), or SolidWorks didn't save it. The PDF goes through a file of its own in the
    /// temporary folder, deleted after.
    /// </summary>
    public (byte[]? Pdf, string? Problem) DrawingPdf(string path)
    {
        var name = Path.GetFileName(path);
        if (OpenDocument(path) is not ModelDoc2 document || document is not DrawingDoc)
        {
            return (null, $"{name} isn't open in SolidWorks, so its PDF wasn't made.");
        }
        if (document.GetSaveFlag())
        {
            return (null, $"{name} has changes that aren't saved, so its PDF wasn't made. Save it and check it in.");
        }
        var target = Path.Combine(Path.GetTempPath(), "vault-" + Guid.NewGuid().ToString("N") + ".pdf");
        try
        {
            var options = (ExportPdfData)_app.GetExportFileData((int)swExportDataFileType_e.swExportPdfData);
            options.SetSheets((int)swExportDataSheetsToExport_e.swExportData_ExportAllSheets, null);
            options.ViewPdfAfterSaving = false;
            int errors = 0, warnings = 0;
            var saved = document.Extension.SaveAs(
                target,
                (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                options,
                ref errors,
                ref warnings);
            if (!saved || !File.Exists(target))
            {
                return (null, $"SolidWorks didn't save {name} as a PDF (error {errors}), so its PDF wasn't made.");
            }
            return (File.ReadAllBytes(target), null);
        }
        finally
        {
            try
            {
                File.Delete(target);
            }
            catch (IOException e)
            {
                Log.Info($"The temporary PDF {target} wasn't deleted: {e.Message}");
            }
            catch (UnauthorizedAccessException e)
            {
                Log.Info($"The temporary PDF {target} wasn't deleted: {e.Message}");
            }
        }
    }
}
