using System;
using System.Globalization;
using System.IO;

namespace Vault.SolidWorks;

/// <summary>
/// %LOCALAPPDATA%\Vault\addin.log. The add-in runs inside SolidWorks, so this file is how to
/// find out what went wrong; keep messages specific.
/// </summary>
internal static class Log
{
    public static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vault", "addin.log");

    private const long MaxBytes = 1024 * 1024;
    private static readonly object Lock = new object();

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string message, Exception? error = null) =>
        Write("ERROR", error == null ? message : message + ": " + error);

    private static void Write(string level, string message)
    {
        lock (Lock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > MaxBytes)
                {
                    File.Copy(FilePath, FilePath + ".1", overwrite: true);
                    File.Delete(FilePath);
                }
                var time = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
                File.AppendAllText(FilePath, $"{time} {level} {message}{Environment.NewLine}");
            }
            catch (IOException)
            {
                // Logging must never break SolidWorks.
            }
            catch (UnauthorizedAccessException)
            {
                // Same.
            }
        }
    }
}
