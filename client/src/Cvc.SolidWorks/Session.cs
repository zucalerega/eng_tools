using System;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

namespace Cvc.SolidWorks;

/// <summary>The add-in while SolidWorks runs: the CVC task pane and the SolidWorks events it follows.</summary>
internal sealed class Session : IDisposable
{
    private readonly SldWorks _app;
    private readonly CvcPane _pane;
    private readonly DocumentWatcher _documents;
    private readonly TaskpaneView _taskPane;

    public Session(SldWorks app)
    {
        _app = app;
        var host = new SolidWorksHost(app);
        _pane = new CvcPane(host);
        _documents = new DocumentWatcher(host, _pane);
        _taskPane = app.CreateTaskpaneView3(Icons.Write(), "CVC: check files in and out");
        _taskPane.DisplayWindowFromHandlex64(_pane.Handle.ToInt64());
        app.ActiveDocChangeNotify += OnActiveDocumentChanged;
        app.FileOpenPostNotify += OnFileOpened;
        app.DocumentLoadNotify2 += OnDocumentLoaded;
        app.FileNewNotify2 += OnFileNew;
        _documents.WatchOpenDocuments();
        _pane.Start();
    }

    public void Dispose()
    {
        _app.ActiveDocChangeNotify -= OnActiveDocumentChanged;
        _app.FileOpenPostNotify -= OnFileOpened;
        _app.DocumentLoadNotify2 -= OnDocumentLoaded;
        _app.FileNewNotify2 -= OnFileNew;
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
