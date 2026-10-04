using System;
using System.IO;
using System.Text.Json;

namespace Vault.SolidWorks;

/// <summary>%APPDATA%\Vault\addin.json: where the workspace is and which server it was set up with.</summary>
internal sealed class AddinSettings
{
    private static readonly string AppData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    private static readonly string FilePath = Path.Combine(AppData, "Vault", "addin.json");

    // Where they were before 0.4.0, when the add-in was CVC's: taken from there once, so the add-in keeps its
    // workspace and server.
    private static readonly string OldFilePath = Path.Combine(AppData, "CVC", "addin.json");

    public string WorkspaceRoot { get; set; } = @"C:\VLT";

    public string? Server { get; set; }

    public static AddinSettings Load()
    {
        var old = !File.Exists(FilePath) && File.Exists(OldFilePath);
        var path = old ? OldFilePath : FilePath;
        try
        {
            var settings = File.Exists(path)
                ? JsonSerializer.Deserialize<AddinSettings>(File.ReadAllText(path)) ?? new AddinSettings()
                : new AddinSettings();
            if (old)
            {
                settings.Save();
                Log.Info($"Moved the add-in's settings from {OldFilePath} to {FilePath}");
            }
            return settings;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Error("Couldn't read " + path + "; using defaults", e);
            return new AddinSettings();
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
