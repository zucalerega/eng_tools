using System;
using System.IO;
using System.Reflection;

namespace Cvc.SolidWorks;

/// <summary>
/// Loads the add-in's own dependencies (Cvc.Client, System.Text.Json, ...) from its folder.
/// An add-in runs inside SLDWORKS.exe, which has no binding redirects for our packages, and
/// other add-ins may have loaded different versions; without this, a version mismatch is a
/// FileLoadException.
/// </summary>
internal static class AssemblyLoading
{
    private static bool _installed;

    public static void Install()
    {
        if (_installed)
        {
            return;
        }
        _installed = true;
        var folder = Path.GetDirectoryName(typeof(AssemblyLoading).Assembly.Location);
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
        {
            var name = new AssemblyName(args.Name).Name;
            var candidate = Path.Combine(folder, name + ".dll");
            return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
        };
    }
}
