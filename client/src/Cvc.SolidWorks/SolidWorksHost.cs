using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Cvc.SolidWorks;

/// <summary>
/// The few SolidWorks API calls CVC needs, in one place. Call only on SolidWorks' main thread.
/// </summary>
internal sealed class SolidWorksHost
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

    public bool IsOpen(string path) => OpenDocument(path) != null;

    public bool HasUnsavedChanges(string path) => OpenDocument(path)?.GetSaveFlag() == true;

    /// <summary>The files a SolidWorks file uses directly: an assembly's components, a drawing's models.</summary>
    public IReadOnlyList<string> References(string path)
    {
        var found = new List<string>();
        if (!IsSolidWorksFile(path)
            || _app.GetDocumentDependencies2(path, false, true, false) is not object[] pairs)
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

    /// <summary>Switch an open document between read-only and editable, to match its file after a check-out or check-in.</summary>
    public void SetReadOnly(string path, bool readOnly) => OpenDocument(path)?.SetReadOnlyState(readOnly);

    /// <summary>Close a document without saving it.</summary>
    public void Close(string path) => _app.CloseDoc(path);

    public void Open(string path)
    {
        if (!IsSolidWorksFile(path))
        {
            return;
        }
        int errors = 0, warnings = 0;
        _app.OpenDoc6(path, (int)DocumentType(path), (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref errors, ref warnings);
        if (errors != 0)
        {
            Log.Error($"Opening {path} returned SolidWorks error {errors}");
        }
    }

    private static swDocumentTypes_e DocumentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".sldasm" => swDocumentTypes_e.swDocASSEMBLY,
        ".slddrw" => swDocumentTypes_e.swDocDRAWING,
        _ => swDocumentTypes_e.swDocPART,
    };
}
