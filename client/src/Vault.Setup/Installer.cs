using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using Microsoft.Win32;

namespace Vault.Setup;

/// <summary>A step of installing or removing that couldn't be done; its message says what to do.</summary>
internal sealed class SetupException : Exception
{
    public SetupException(string message)
        : base(message)
    {
    }
}

/// <summary>
/// What setup does, as install.ps1 and uninstall.ps1 do by hand: puts the add-in's files (carried in this exe)
/// in Program Files, registers the add-in with COM (RegAsm), which also tells SolidWorks about it, and
/// registers vault:// (and cvc://) links for vault-open.exe. It copies itself there too, and lists itself in
/// Windows' installed apps, to remove all of that again. Workspaces, sign-ins, and settings are the user's: they
/// stay. Over an install from before 0.4.0, when the add-in was CVC's, it first takes that one away (RemoveOld).
/// </summary>
internal static class Installer
{
    public const string Product = "Vault for SolidWorks";
    private const string Publisher = "Yellow Jacket Space Program";
    private const string AddInClass = "{eb689878-bd0e-44c5-b2e4-f958d6061b99}"; // Vault.SolidWorks.AddIn.Id
    private const string AddInDll = "Vault.SolidWorks.dll";
    private const string LinkExe = "vault-open.exe";
    private const string SetupExe = "Vault-Setup.exe";
    // vault:// links, and cvc:// ones, which the web app makes until every laptop has an add-in that follows
    // vault:// (docs/design.md, "Names from before YJSP"): both go to vault-open.exe.
    private static readonly string[] LinkKeys = { @"SOFTWARE\Classes\vault", @"SOFTWARE\Classes\cvc" };
    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VaultForSolidWorks";

    // The add-in's files before 0.4.0, when it was CVC's (without its debug symbols, which setup never carried).
    private const string OldAddInDll = "Cvc.SolidWorks.dll";
    private static readonly string[] OldFiles = { OldAddInDll, "Cvc.Client.dll", "cvc-open.exe", "cvc-open.exe.config" };

    public static string Folder { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Product);

    /// <summary>
    /// Where the vault's files go, the same on every computer (Vault.Client's Workspace.DefaultRoot). Setup makes it,
    /// so it's there to save parts in; connecting SolidWorks to a vault fills it with the vault's folders. Removing
    /// the add-in leaves it: what's in it is the user's.
    /// </summary>
    public const string VaultFolder = @"C:\VLT";

    public static string Version
    {
        get
        {
            var version = typeof(Installer).Assembly.GetName().Version ?? new Version(0, 0, 0);
            return $"{version.Major}.{version.Minor}.{version.Build}";
        }
    }

    /// <summary>The version installed now, or null.</summary>
    public static string? InstalledVersion
    {
        get
        {
            using var app = Registry.LocalMachine.OpenSubKey(UninstallKey);
            return app?.GetValue("DisplayVersion") as string;
        }
    }

    /// <summary>SolidWorks, running: it has the add-in loaded, so its files can't be replaced or removed.</summary>
    public static Process[] SolidWorks() => Process.GetProcessesByName("SLDWORKS");

    public static void Install(Action<string> progress)
    {
        RemoveOld(progress);
        progress("Copying the add-in to " + Folder);
        Directory.CreateDirectory(Folder);
        long size = 0;
        using (var payload = Payload())
        {
            foreach (var entry in payload.Entries.Where(e => e.Name.Length > 0))
            {
                var target = Target(entry);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                using var from = entry.Open();
                using var to = File.Create(target);
                from.CopyTo(to);
                size += entry.Length;
            }
        }
        // Setup stays, to remove the add-in from Windows' installed apps. Copied byte by byte: a plain copy
        // would keep the downloaded file's mark, and Windows would warn about it again then.
        var setup = Path.Combine(Folder, SetupExe);
        var self = Assembly.GetExecutingAssembly().Location;
        if (!string.Equals(Path.GetFullPath(self), setup, StringComparison.OrdinalIgnoreCase))
        {
            File.WriteAllBytes(setup, File.ReadAllBytes(self));
        }

        progress("Registering the add-in with SolidWorks");
        RegAsm("/codebase", Path.Combine(Folder, AddInDll));

        progress("Making " + VaultFolder + ", for the vault's files");
        Directory.CreateDirectory(VaultFolder);

        progress("Registering Vault links, for Open in SolidWorks");
        foreach (var key in LinkKeys)
        {
            using (var link = Registry.LocalMachine.CreateSubKey(key))
            {
                link.SetValue(null, "URL:Vault");
                link.SetValue("URL Protocol", "");
            }
            using var command = Registry.LocalMachine.CreateSubKey(key + @"\shell\open\command");
            command.SetValue(null, $"\"{Path.Combine(Folder, LinkExe)}\" \"%1\"");
        }

        using var app = Registry.LocalMachine.CreateSubKey(UninstallKey);
        app.SetValue("DisplayName", Product);
        app.SetValue("DisplayVersion", Version);
        app.SetValue("Publisher", Publisher);
        app.SetValue("InstallLocation", Folder);
        app.SetValue("DisplayIcon", setup);
        app.SetValue("UninstallString", $"\"{setup}\" /uninstall");
        app.SetValue("NoModify", 1, RegistryValueKind.DWord);
        app.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        app.SetValue("EstimatedSize", (int)((size + new FileInfo(setup).Length) / 1024), RegistryValueKind.DWord);
    }

    public static void Uninstall(Action<string> progress)
    {
        var dll = Path.Combine(Folder, AddInDll);
        // Only this copy's registrations: a developer's copy registered from elsewhere stays.
        if (File.Exists(dll) && Here(Registry.ClassesRoot, $@"CLSID\{AddInClass}\InprocServer32", "CodeBase"))
        {
            progress("Removing the add-in from SolidWorks");
            RegAsm("/unregister", dll);
        }
        foreach (var key in LinkKeys.Where(key => Here(Registry.LocalMachine, key + @"\shell\open\command", null)))
        {
            Registry.LocalMachine.DeleteSubKeyTree(key, throwOnMissingSubKey: false);
        }

        progress("Deleting its files");
        using (var payload = Payload())
        {
            foreach (var entry in payload.Entries.Where(e => e.Name.Length > 0))
            {
                File.Delete(Target(entry));
            }
        }
        foreach (var name in OldFiles)
        {
            File.Delete(Path.Combine(Folder, name)); // left by an install from before 0.4.0, if one was
        }
        Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);
    }

    /// <summary>
    /// The add-in as installed before 0.4.0, when it was CVC's (Cvc.SolidWorks.dll, cvc-open.exe), taken away before
    /// this one goes in: unregistered, so its COM entries don't stay behind, and its files deleted. This one registers
    /// the same COM class (AddInClass), so SolidWorks sees one add-in throughout. Its settings, sign-ins, and
    /// workspaces are the user's, and the add-in takes them over (AddinSettings, TokenStore, Workspace).
    /// </summary>
    private static void RemoveOld(Action<string> progress)
    {
        var old = Path.Combine(Folder, OldAddInDll);
        if (!File.Exists(old))
        {
            return;
        }
        progress("Removing the add-in's version from before 0.4.0");
        if (Here(Registry.ClassesRoot, $@"CLSID\{AddInClass}\InprocServer32", "CodeBase"))
        {
            RegAsm("/unregister", old);
        }
        foreach (var name in OldFiles)
        {
            File.Delete(Path.Combine(Folder, name));
        }
    }

    /// <summary>
    /// After uninstalling, as setup exits: delete the copy of setup in the folder (this program, run from
    /// Windows' installed apps), and the folder if nothing else is left in it, once it has closed.
    /// </summary>
    public static void RemoveSetupOnExit()
    {
        var setup = Path.Combine(Folder, SetupExe);
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & del /f /q \"{setup}\" & rmdir \"{Folder}\"")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        })?.Dispose();
    }

    private static ZipArchive Payload()
    {
        var zip = typeof(Installer).Assembly.GetManifestResourceStream("addin.zip")
            ?? throw new SetupException("This copy of setup doesn't carry the add-in. Download it again.");
        return new ZipArchive(zip, ZipArchiveMode.Read);
    }

    private static string Target(ZipArchiveEntry entry)
    {
        var target = Path.GetFullPath(Path.Combine(Folder, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(Folder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new SetupException($"The add-in has a file that doesn't belong in {Folder}: {entry.FullName}");
        }
        return target;
    }

    /// <summary>Whether a registry value names a file in this install's folder.</summary>
    private static bool Here(RegistryKey root, string key, string? name)
    {
        using var found = root.OpenSubKey(key);
        var value = found?.GetValue(name) as string ?? "";
        var path = Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.IsFile ? uri.LocalPath : value;
        return path.IndexOf(Folder, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /// <summary>The .NET Framework's RegAsm (64-bit, as SolidWorks is), which runs the add-in's own registration.</summary>
    private static void RegAsm(string action, string dll)
    {
        var regasm = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe");
        if (!File.Exists(regasm))
        {
            throw new SetupException("This computer doesn't have the .NET Framework 4.8 that SolidWorks needs: install SolidWorks 2025 first.");
        }
        var start = new ProcessStartInfo(regasm, $"{action} \"{dll}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(start) ?? throw new SetupException("RegAsm didn't start.");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new SetupException($"RegAsm couldn't register the add-in (exit code {process.ExitCode}): {(output.Result + errors.Result).Trim()}");
        }
    }
}
