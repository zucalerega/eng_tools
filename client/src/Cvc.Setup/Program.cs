using System;
using System.Linq;
using System.Windows.Forms;

namespace Cvc.Setup;

/// <summary>Vault-Setup.exe installs the add-in; Vault-Setup.exe /uninstall (from Windows' installed apps) removes it.</summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var uninstall = args.Any(a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase));
        using var form = new SetupForm(uninstall);
        Application.Run(form);
        if (form.Uninstalled)
        {
            Installer.RemoveSetupOnExit();
        }
    }
}
