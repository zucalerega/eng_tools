using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Vault.SolidWorks;

/// <summary>
/// The few SolidWorks API calls the add-in needs, in one place. Call only on SolidWorks' main thread.
/// </summary>
internal sealed partial class SolidWorksHost
{
    private static readonly string[] SolidWorksExtensions = { ".sldprt", ".sldasm", ".slddrw" };
    private readonly SldWorks _app;

    public SolidWorksHost(SldWorks app) => _app = app;

    /// <summary>The active document's file, or null (nothing open, or a new document not saved yet).</summary>
    public string? ActiveDocumentPath => PathOf(_app.ActiveDoc as ModelDoc2);

    public static string? PathOf(ModelDoc2? document)
    {
        var path = document?.GetPathName();
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public static bool IsSolidWorksFile(string path) =>
        SolidWorksExtensions.Contains(Path.GetExtension(path).ToLowerInvariant());

    public static bool IsAssembly(string path) => Path.GetExtension(path).Equals(".sldasm", StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether a file can go in an assembly: a part, or another assembly.</summary>
    public static bool IsComponent(string path) => IsAssembly(path) || Path.GetExtension(path).Equals(".sldprt", StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<ModelDoc2> OpenDocuments()
    {
        var documents = new List<ModelDoc2>();
        if (_app.GetDocuments() is object[] all)
        {
            documents.AddRange(all.OfType<ModelDoc2>());
        }
        return documents;
    }

    public ModelDoc2? OpenDocument(string path) => _app.GetOpenDocumentByName(path) as ModelDoc2;

    public bool HasUnsavedChanges(string path) => OpenDocument(path)?.GetSaveFlag() == true;

    /// <summary>The files a SolidWorks file uses directly: an assembly's components, a drawing's models.</summary>
    public IReadOnlyList<string> References(string path) => Dependencies(path, search: true);

    /// <summary>
    /// The paths a SolidWorks file keeps for the files it uses directly, as they were when it was saved, without
    /// looking for them. A file brought from elsewhere keeps elsewhere's (Kenesto's K:\...).
    /// </summary>
    public IReadOnlyList<string> KeptReferences(string path) => Dependencies(path, search: false);

    private IReadOnlyList<string> Dependencies(string path, bool search)
    {
        var found = new List<string>();
        if (!IsSolidWorksFile(path)
            || _app.GetDocumentDependencies2(path, false, search, false) is not object[] pairs)
        {
            return found;
        }
        // Pairs of (name, full path).
        for (var i = 0; i + 1 < pairs.Length; i += 2)
        {
            var name = pairs[i] as string ?? "";
            var file = pairs[i + 1] as string ?? "";
            // Virtual components ("Bracket^Motor Mount") live inside the assembly itself.
            if (file.Length > 0 && name.IndexOf('^') < 0 && file.IndexOf('^') < 0)
            {
                found.Add(file);
            }
        }
        return found;
    }

    /// <summary>Every file a SolidWorks file uses, at all levels.</summary>
    public IReadOnlyCollection<string> AllReferences(string path)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>();
        pending.Push(path);
        while (pending.Count > 0)
        {
            foreach (var reference in References(pending.Pop()))
            {
                if (seen.Add(reference))
                {
                    pending.Push(reference);
                }
            }
        }
        return seen;
    }

    public bool Save(string path)
    {
        var document = OpenDocument(path);
        if (document == null || !document.GetSaveFlag())
        {
            return true;
        }
        int errors = 0, warnings = 0;
        return document.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref errors, ref warnings);
    }

    /// <summary>
    /// Switch an open document between read-only and editable, to match its file after a check-out or
    /// check-in. False if SolidWorks couldn't (it makes a document editable only if its file is writable).
    /// </summary>
    public bool SetReadOnly(string path, bool readOnly) => OpenDocument(path)?.SetReadOnlyState(readOnly) ?? true;

    public static bool IsReadOnly(ModelDoc2 document) => document.IsOpenedReadOnly();

    /// <summary>In a Save As pre-notification: save to the document's own file instead of asking for a name.</summary>
    public static void SaveToOwnFile(ModelDoc2 document, string path) => document.SetSaveAsFileName(path);

    /// <summary>Close a document without saving it.</summary>
    public void Close(string path) => _app.CloseDoc(path);

    /// <summary>
    /// Have SolidWorks let go of these files, where they're open, so the add-in can replace them. That includes
    /// parts an open assembly uses, which closing the part's window wouldn't release. Unsaved changes in
    /// them are lost when they're reloaded (<see cref="Released.Reload"/>), so callers check for those first.
    /// </summary>
    public Released Release(IEnumerable<string> paths)
    {
        var released = new Released(this);
        foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            switch (OpenDocument(path))
            {
                case null:
                    break;
                case DrawingDoc:
                    // ForceReleaseLocks is for parts and assemblies. Nothing uses a drawing, so closing it is enough.
                    Close(path);
                    released.Closed.Add(path);
                    break;
                case var document:
                    document.ForceReleaseLocks();
                    released.Documents.Add((document, path));
                    break;
            }
        }
        return released;
    }

    public void Open(string path)
    {
        if (!IsSolidWorksFile(path))
        {
            return;
        }
        int errors = 0, warnings = 0;
        var opened = _app.OpenDoc6(path, (int)DocumentType(path), (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref errors, ref warnings);
        if (opened == null)
        {
            Log.Error($"Opening {path} returned SolidWorks error {errors}");
            return;
        }
        if (errors != 0)
        {
            // It's open, without what it couldn't load (like parts that aren't here): SolidWorks shows which.
            Log.Info($"Opened {path} with SolidWorks error {errors}, warnings {warnings}");
        }
        // Opening a file that's already open doesn't bring its window forward; this does.
        _app.ActivateDoc3(path, false, (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref errors);
    }

    /// <summary>
    /// Add a part or assembly to an open assembly, beside what's in it already, selected and in view, ready to be dragged
    /// into place and mated. SolidWorks adds only files it has open, so one that isn't is opened without a window, and
    /// closed again once it's in (the assembly keeps it loaded). Returns what went wrong, or null.
    /// </summary>
    public string? InsertComponent(string assemblyPath, string componentPath)
    {
        var name = Path.GetFileName(componentPath);
        if (OpenDocument(assemblyPath) is not AssemblyDoc assembly)
        {
            return $"{Path.GetFileName(assemblyPath)} isn't open in SolidWorks.";
        }
        var component = OpenDocument(componentPath);
        var opened = component == null;
        if (opened)
        {
            var type = (int)DocumentType(componentPath);
            int errors = 0, warnings = 0;
            _app.DocumentVisible(false, type);
            try
            {
                component = _app.OpenDoc6(componentPath, type, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref errors, ref warnings);
            }
            finally
            {
                _app.DocumentVisible(true, type);
            }
            if (component == null)
            {
                return $"SolidWorks couldn't open {name} (error {errors}), so it isn't in the assembly.";
            }
        }
        try
        {
            int activating = 0;
            _app.ActivateDoc3(assemblyPath, false, (int)swRebuildOnActivation_e.swDontRebuildActiveDoc, ref activating);
            var (x, y, z) = Beside(assembly, component!);
            var added = assembly.AddComponent5(
                componentPath, (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig, "", false, "", x, y, z);
            if (added == null)
            {
                return $"SolidWorks couldn't add {name} to {Path.GetFileName(assemblyPath)}. An assembly can't go in itself, or in one it's used in.";
            }
            var model = (ModelDoc2)assembly;
            model.ClearSelection2(true);
            added.Select4(false, null, false);
            model.ViewZoomtofit2();
            return null;
        }
        finally
        {
            if (opened)
            {
                _app.CloseDoc(componentPath);
            }
        }
    }

    // Where a new component's center goes: past the right of what the assembly has, level with its middle, so it doesn't
    // land inside another part. The assembly's origin if either has no size to go by.
    private static (double X, double Y, double Z) Beside(AssemblyDoc assembly, ModelDoc2 component)
    {
        try
        {
            var around = Box(assembly.GetBox(0));
            var size = Box(component switch
            {
                PartDoc part => part.GetPartBox(true),
                AssemblyDoc subassembly => subassembly.GetBox(0),
                _ => null,
            });
            if (around == null || size == null)
            {
                return (0, 0, 0);
            }
            var width = size[3] - size[0];
            var gap = Math.Max(0.01, 0.25 * Math.Max(width, around[3] - around[0]));
            return (around[3] + gap + (width / 2), (around[1] + around[4]) / 2, (around[2] + around[5]) / 2);
        }
        catch (COMException e)
        {
            Log.Error("Couldn't measure the assembly to place a component beside it", e);
            return (0, 0, 0);
        }
    }

    // A bounding box, [xmin, ymin, zmin, xmax, ymax, zmax] in meters, or null for one with nothing in it.
    private static double[]? Box(object? box) =>
        box is double[] { Length: 6 } corners && corners[3] - corners[0] + corners[4] - corners[1] + corners[5] - corners[2] > 0 ? corners : null;

    /// <summary>
    /// Start a new part, assembly, or drawing from SolidWorks' default template for it (a drawing with a view
    /// of model), and save it at path, leaving it open. Returns what went wrong, or null.
    /// </summary>
    public string? CreateDocument(string path, string? model)
    {
        var type = DocumentType(path);
        var (preference, kind) = type switch
        {
            swDocumentTypes_e.swDocASSEMBLY => (swUserPreferenceStringValue_e.swDefaultTemplateAssembly, "assembly"),
            swDocumentTypes_e.swDocDRAWING => (swUserPreferenceStringValue_e.swDefaultTemplateDrawing, "drawing"),
            _ => (swUserPreferenceStringValue_e.swDefaultTemplatePart, "part"),
        };
        var template = _app.GetUserPreferenceStringValue((int)preference);
        if (string.IsNullOrEmpty(template) || !File.Exists(template))
        {
            return $"SolidWorks has no default {kind} template. Choose one in Tools > Options > System Options > Default Templates, then try again.";
        }
        if (_app.NewDocument(template, 0, 0, 0) is not ModelDoc2 document)
        {
            return $"SolidWorks couldn't start a new {kind} from {template}.";
        }
        if (model != null && document is DrawingDoc drawing)
        {
            // One view to start from, in the middle of the sheet; the model loads for it if it isn't open.
            double width = 0, height = 0;
            ((Sheet)drawing.GetCurrentSheet()).GetSize(ref width, ref height);
            if (drawing.CreateDrawViewFromModelView3(model, "*Isometric", width / 2, height / 2, 0) == null)
            {
                return $"SolidWorks couldn't put a view of {Path.GetFileName(model)} on the new drawing. It's open, not saved.";
            }
        }
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        int errors = 0, warnings = 0;
        var saved = document.Extension.SaveAs3(
            path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion, (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref errors, ref warnings);
        return saved ? null : $"SolidWorks couldn't save {path} (error {errors}). The new {kind} is open, not saved.";
    }

    /// <summary>Bring SolidWorks' window to the front, when vault-open (following a link from the web app) allowed it.</summary>
    public static void BringToFront()
    {
        var window = Process.GetCurrentProcess().MainWindowHandle;
        if (window == IntPtr.Zero)
        {
            return;
        }
        if (IsIconic(window))
        {
            ShowWindow(window, 9); // SW_RESTORE
        }
        SetForegroundWindow(window);
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    private static swDocumentTypes_e DocumentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".sldasm" => swDocumentTypes_e.swDocASSEMBLY,
        ".slddrw" => swDocumentTypes_e.swDocDRAWING,
        _ => swDocumentTypes_e.swDocPART,
    };

    /// <summary>Open files SolidWorks has let go of (see <see cref="Release"/>), to load again once replaced.</summary>
    internal sealed class Released
    {
        private readonly SolidWorksHost _sw;

        public Released(SolidWorksHost sw) => _sw = sw;

        public List<(ModelDoc2 Document, string Path)> Documents { get; } = new List<(ModelDoc2, string)>();

        public List<string> Closed { get; } = new List<string>();

        /// <summary>
        /// Load the files again, in place: read-only or editable to match the file on disk. A document
        /// changed since it was released keeps its changes and isn't reloaded, unless discardChanges is
        /// set; those are returned.
        /// </summary>
        public IReadOnlyList<string> Reload(bool discardChanges)
        {
            var kept = new List<string>();
            foreach (var (document, path) in Documents)
            {
                if (!discardChanges && document.GetSaveFlag())
                {
                    kept.Add(path);
                    continue;
                }
                var readOnly = !File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0;
                var result = (swComponentReloadError_e)document.ReloadOrReplace(readOnly, path, true);
                if (result is not (swComponentReloadError_e.swReloadOkay or swComponentReloadError_e.swDocumentNotChanged or swComponentReloadError_e.swReadOnlyChanged))
                {
                    Log.Error($"Reloading {path} after replacing it failed: {result}");
                }
            }
            foreach (var path in Closed)
            {
                _sw.Open(path);
            }
            return kept;
        }
    }
}
