using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace Vault.SolidWorks.Open;

/// <summary>
/// vault-open.exe "vault://open?server=...&amp;path=...": opens a vault file in SolidWorks, for the web app's
/// "Open in SolidWorks", or (vault://new) starts a new part, assembly, or drawing there, or (vault://connect)
/// signs SolidWorks in to that vault. It hands the link to the Vault add-in, starting SolidWorks first if
/// it isn't running; the add-in does the rest. What goes wrong before the add-in has the link, it says itself.
/// </summary>
internal static class Program
{
    private static readonly TimeSpan Answer = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Startup = TimeSpan.FromMinutes(3); // SolidWorks, then its add-ins
    private static readonly string[] Actions = { "open", "new", "connect" };

    // The SolidWorks a link starts when none is running: 2026, the team's, or 2025 on a computer that hasn't moved yet.
    private static readonly int[] Years = { 2026, 2025 };
    private const string Scheme = "vault"; // OpenLink.Scheme

    // The add-in's log (its Log.FilePath): one file says what became of a click, from here into SolidWorks.
    private static readonly string LogFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vault", "addin.log");

    [STAThread]
    private static int Main(string[] args)
    {
        var link = args.Length == 1 ? args[0] : "";
        Note("INFO", "vault-open.exe got " + (link.Length > 0 ? link : "nothing"));
        try
        {
            // Only Vault's links: anything else shouldn't start SolidWorks. The add-in checks the rest.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != Scheme
                || !Actions.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
            {
                return Fail("This follows links from the Vault web app (Open in SolidWorks, New part, Connect SolidWorks). It was given: " + (link.Length > 0 ? link : "nothing"));
            }
            var problem = HandToAddIn(link);
            return problem.Length == 0 ? 0 : Fail(problem);
        }
        catch (Exception e) when (e is IOException or TimeoutException or InvalidOperationException or Win32Exception or UnauthorizedAccessException)
        {
            return Fail("Couldn't open the file in SolidWorks: " + e.Message);
        }
    }

    private static string HandToAddIn(string link)
    {
        var session = Process.GetCurrentProcess().SessionId;
        var solidWorks = Process.GetProcessesByName("SLDWORKS").FirstOrDefault(p => p.SessionId == session);
        var wait = Answer;
        if (solidWorks == null)
        {
            if (Start() is not { } started)
            {
                return "SolidWorks 2026 isn't installed on this computer.";
            }
            solidWorks = started;
            wait = Startup;
        }
        else if (RunningFor(solidWorks) is { } running && running < Startup - Answer)
        {
            wait = Startup - running; // started a moment ago: its add-ins may not have loaded yet
        }
        AllowSetForegroundWindow(solidWorks.Id); // so the add-in can bring SolidWorks to the front

        var name = OpenPipe.Name(session);
        using var pipe = Connect(name, wait, solidWorks);
        if (pipe == null)
        {
            return Closed(solidWorks) ? "SolidWorks closed before it could open the file."
                // The add-in takes one link at a time, and is still on an earlier one.
                : Listening(name) ? "Vault in SolidWorks is still busy with a link you clicked before. Wait for that file to open, or "
                    + "answer Vault's message in SolidWorks, then try again."
                : "The Vault add-in isn't answering in SolidWorks. In SolidWorks, check Tools > Add-ins: tick both of Vault's boxes, "
                    + $"so it starts with SolidWorks. If they're ticked, {LogFile} says why it didn't start.";
        }
        OpenPipe.Write(pipe, link);
        return OpenPipe.Read(pipe) ?? $"The Vault add-in stopped before answering. Details may be in {LogFile}.";
    }

    private static Process? Start()
    {
        foreach (var year in Years)
        {
            var folder = Registry.GetValue($@"HKEY_LOCAL_MACHINE\SOFTWARE\SolidWorks\SOLIDWORKS {year}\Setup", "SolidWorks Folder", null) as string;
            var exe = folder == null ? null : Path.Combine(folder, "SLDWORKS.exe");
            if (exe != null && File.Exists(exe))
            {
                Note("INFO", $"vault-open.exe is starting SolidWorks {year}");
                return Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            }
        }
        return null;
    }

    private static NamedPipeClientStream? Connect(string name, TimeSpan wait, Process solidWorks)
    {
        var deadline = DateTime.UtcNow + wait;
        while (DateTime.UtcNow < deadline)
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut);
            try
            {
                pipe.Connect(1000);
                return pipe;
            }
            catch (Exception e) when (e is TimeoutException or IOException)
            {
                pipe.Dispose(); // not listening yet (SolidWorks starting), or busy with another link
            }
            if (Closed(solidWorks))
            {
                return null;
            }
            Thread.Sleep(250);
        }
        return null;
    }

    // Windows doesn't say this of a SolidWorks run as administrator: it's taken as running, and as not just started.
    private static bool Closed(Process solidWorks)
    {
        try
        {
            solidWorks.Refresh();
            return solidWorks.HasExited;
        }
        catch (Win32Exception)
        {
            return false;
        }
    }

    private static TimeSpan? RunningFor(Process solidWorks)
    {
        try
        {
            return DateTime.Now - solidWorks.StartTime;
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    // Whether the add-in's pipe is there, though it isn't taking a link: there and busy is a timeout; not there, not found.
    private static bool Listening(string name) => WaitNamedPipe(@"\\.\pipe\" + name, 1) || Marshal.GetLastWin32Error() == ErrorSemTimeout;

    private const int ErrorSemTimeout = 121;

    private static int Fail(string message)
    {
        Note("ERROR", "vault-open.exe: " + message);
        // On top: once this has started SolidWorks, SolidWorks is in front, and a plain message would open behind it, unseen.
        MessageBoxW(IntPtr.Zero, message, "Vault", MbIconWarning | MbSetForeground | MbTopmost);
        return 1;
    }

    // A line in the add-in's log, as the add-in writes them. If it can't be written, the message box still says it.
    private static void Note(string level, string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogFile)!);
            var time = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            File.AppendAllText(LogFile, $"{time} {level} {message}{Environment.NewLine}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // The add-in writing at the same moment, say.
        }
    }

    private const uint MbIconWarning = 0x30;
    private const uint MbSetForeground = 0x10000;
    private const uint MbTopmost = 0x40000;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WaitNamedPipe(string name, int timeout);
}
