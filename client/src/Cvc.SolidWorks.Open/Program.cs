using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Cvc.SolidWorks.Open;

/// <summary>
/// cvc-open.exe "cvc://open?server=...&amp;path=...": opens a vault file in SolidWorks, for the web app's
/// "Open in SolidWorks". It hands the link to the CVC add-in, starting SolidWorks first if it isn't
/// running; the add-in gets the latest version, and the parts it uses, and opens it.
/// </summary>
internal static class Program
{
    private static readonly TimeSpan Answer = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Startup = TimeSpan.FromMinutes(3); // SolidWorks, then its add-ins

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            var link = args.Length == 1 ? args[0] : "";
            // Only open links: anything else shouldn't start SolidWorks. The add-in checks the rest.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != "cvc" || !uri.Host.Equals("open", StringComparison.OrdinalIgnoreCase))
            {
                return Fail("This opens files from the CVC web app (Open in SolidWorks). It was given: " + (link.Length > 0 ? link : "nothing"));
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
                return "SolidWorks 2025 isn't installed on this computer.";
            }
            solidWorks = started;
            wait = Startup;
        }
        AllowSetForegroundWindow(solidWorks.Id); // so the add-in can bring SolidWorks to the front

        using var pipe = Connect(OpenPipe.Name(session), wait, solidWorks);
        if (pipe == null)
        {
            return solidWorks.HasExited
                ? "SolidWorks closed before it could open the file."
                : "The CVC add-in isn't answering in SolidWorks. Check that it's on: Tools > Add-ins > CVC.";
        }
        OpenPipe.Write(pipe, link);
        return OpenPipe.Read(pipe) ?? "The CVC add-in stopped before answering. Details may be in %LOCALAPPDATA%\\CVC\\addin.log.";
    }

    private static Process? Start()
    {
        var folder = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\SolidWorks\SOLIDWORKS 2025\Setup", "SolidWorks Folder", null) as string;
        var exe = folder == null ? null : Path.Combine(folder, "SLDWORKS.exe");
        return exe != null && File.Exists(exe) ? Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }) : null;
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
            solidWorks.Refresh();
            if (solidWorks.HasExited)
            {
                return null;
            }
            Thread.Sleep(250);
        }
        return null;
    }

    private static int Fail(string message)
    {
        MessageBox.Show(message, "CVC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
    }

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);
}
