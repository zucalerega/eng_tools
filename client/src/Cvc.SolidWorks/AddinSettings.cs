using System;
using System.IO;
using System.Text.Json;

namespace Cvc.SolidWorks;

/// <summary>%APPDATA%\CVC\addin.json: where the workspace is and which server it was set up with.</summary>
internal sealed class AddinSettings
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CVC", "addin.json");

    public string WorkspaceRoot { get; set; } = @"C:\VLT";

    public string? Server { get; set; }

    public static AddinSettings Load()
    {
        try
        {
            return File.Exists(FilePath)
                ? JsonSerializer.Deserialize<AddinSettings>(File.ReadAllText(FilePath)) ?? new AddinSettings()
                : new AddinSettings();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Error("Couldn't read " + FilePath + "; using defaults", e);
            return new AddinSettings();
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
