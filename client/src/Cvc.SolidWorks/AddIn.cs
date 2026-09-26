using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swpublished;

[assembly: ComVisible(false)]

namespace Cvc.SolidWorks;

/// <summary>
/// The SolidWorks add-in. install.ps1 registers it with COM (RegAsm), which also runs Register
/// below to tell SolidWorks about it; SolidWorks then creates it at startup and calls ConnectToSW.
/// Everything people see is in the CVC task pane.
/// </summary>
[ComVisible(true)]
[Guid(Id)]
[ProgId("Cvc.SolidWorks.AddIn")]
public sealed class AddIn : ISwAddin
{
    public const string Id = "eb689878-bd0e-44c5-b2e4-f958d6061b99";
    private const string Title = "Vault";
    private const string Description = "Check SolidWorks files in and out of Vault";

    private IDisposable? _session;

    static AddIn() => AssemblyLoading.Install();

    public bool ConnectToSW(object ThisSW, int Cookie)
    {
        try
        {
            _session = Start(ThisSW);
            Log.Info($"CVC add-in {typeof(AddIn).Assembly.GetName().Version} started");
            return true;
        }
        catch (Exception e)
        {
            Log.Error("The CVC add-in couldn't start", e);
            return false;
        }
    }

    public bool DisconnectFromSW()
    {
        try
        {
            _session?.Dispose();
        }
        catch (Exception e)
        {
            Log.Error("Error while unloading the CVC add-in", e);
        }
        _session = null;
        // Release COM references now, before SolidWorks unloads the add-in.
        GC.Collect();
        GC.WaitForPendingFinalizers();
        return true;
    }

    // A separate method, so Cvc.Client and its dependencies load only after the resolver is installed.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static IDisposable Start(object app) => new Session((SldWorks)app);

    [ComRegisterFunction]
    public static void Register(Type type)
    {
        using (var addins = Registry.LocalMachine.CreateSubKey($@"SOFTWARE\SolidWorks\Addins\{{{type.GUID}}}"))
        {
            addins.SetValue(null, 0);
            addins.SetValue("Title", Title);
            addins.SetValue("Description", Description);
        }
        // Load when SolidWorks starts (for the account that runs the installer).
        using var startup = Registry.CurrentUser.CreateSubKey($@"Software\SolidWorks\AddInsStartup\{{{type.GUID}}}");
        startup.SetValue(null, 1, RegistryValueKind.DWord);
    }

    [ComUnregisterFunction]
    public static void Unregister(Type type)
    {
        Registry.LocalMachine.DeleteSubKey($@"SOFTWARE\SolidWorks\Addins\{{{type.GUID}}}", throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKey($@"Software\SolidWorks\AddInsStartup\{{{type.GUID}}}", throwOnMissingSubKey: false);
    }
}
