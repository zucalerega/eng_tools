using System;
using System.Linq;
using System.Windows.Forms;

namespace Vault.Setup;

/// <summary>
/// Vault-Setup.exe installs the add-in; Vault-Setup.exe /uninstall (from Windows' installed apps) removes it, and
/// Vault-Setup.exe /update (from the add-in's Update button) updates it as soon as SolidWorks closes.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var uninstall = args.Any(a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase));
        var update = args.Any(a => a.Equals("/update", StringComparison.OrdinalIgnoreCase));
        using var form = new SetupForm(uninstall, update);
        Application.Run(form);
        if (form.Uninstalled)
        {
            Installer.RemoveSetupOnExit();
        }
    }
}
