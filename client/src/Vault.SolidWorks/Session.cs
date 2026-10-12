using System;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

namespace Vault.SolidWorks;

/// <summary>The add-in while SolidWorks runs: the Vault task pane and the SolidWorks events it follows.</summary>
internal sealed class Session : IDisposable
{
    private readonly SldWorks _app;
    private readonly VaultPane _pane;
    private readonly DocumentWatcher _documents;
    private readonly TaskpaneView _taskPane;
    private readonly LinkListener _links;

    public Session(SldWorks app)
    {
        _app = app;
        var host = new SolidWorksHost(app);
        _pane = new VaultPane(host);
        _documents = new DocumentWatcher(host, _pane);
        _taskPane = app.CreateTaskpaneView3(Icons.Write(), "Vault: check files in and out");
        _taskPane.DisplayWindowFromHandlex64(_pane.Handle.ToInt64());
        _pane.FillHostWindow();
        _pane.ShowTab = () => _taskPane.ShowView();
        app.ActiveDocChangeNotify += OnActiveDocumentChanged;
        app.FileOpenPostNotify += OnFileOpened;
        app.DocumentLoadNotify2 += OnDocumentLoaded;
        app.FileNewNotify2 += OnFileNew;
        app.ReferenceNotFoundNotify += OnReferenceNotFound;
        _documents.WatchOpenDocuments();
        _pane.Start();
        _links = new LinkListener(_pane);
    }

    public void Dispose()
    {
        _links.Dispose();
        _app.ActiveDocChangeNotify -= OnActiveDocumentChanged;
        _app.FileOpenPostNotify -= OnFileOpened;
        _app.DocumentLoadNotify2 -= OnDocumentLoaded;
        _app.FileNewNotify2 -= OnFileNew;
        _app.ReferenceNotFoundNotify -= OnReferenceNotFound;
        _documents.Dispose();
        _taskPane.DeleteView();
        Marshal.ReleaseComObject(_taskPane);
        _pane.Dispose();
    }

    private int OnActiveDocumentChanged() => Guard(() =>
    {
        _documents.WatchOpenDocuments();
        _pane.ActiveDocumentChanged();
    });

    private int OnFileOpened(string fileName) => Guard(() =>
    {
        _documents.WatchOpenDocuments();
        _pane.RefreshSoon();
    });

    private int OnDocumentLoaded(string title, string path) => Guard(_documents.WatchOpenDocuments);

    // Follow a new document from the start: nothing else tells us when it's first saved.
    private int OnFileNew(object document, int type, string template) => Guard(_documents.WatchOpenDocuments);

    // SolidWorks can't find a file an assembly or drawing uses, where it was or near the assembly. A file brought
    // from elsewhere keeps elsewhere's paths (Kenesto's K:\...): the file in the workspace whose path ends the same
    // way is the one it means. Without an answer, SolidWorks asks.
    private int OnReferenceNotFound(string fileName) => Guard(() =>
    {
        var found = _pane.LocalFileFor(fileName);
        Log.Info($"SolidWorks couldn't find {fileName}: {found ?? "no file here ends like it"}");
        if (found != null)
        {
            _app.SetMissingReferencePathName(found);
        }
    });

    // An exception must never escape into SolidWorks.
    private static int Guard(Action handler)
    {
        try
        {
            handler();
        }
        catch (Exception e)
        {
            Log.Error("A SolidWorks event handler failed", e);
        }
        return 0;
    }
}
