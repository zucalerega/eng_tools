using System;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Cvc.SolidWorks;

/// <summary>
/// Follows each open document's edits and saves, so CVC can offer to check a file out when
/// you start changing it, and explain why a file that isn't checked out won't save.
/// </summary>
internal sealed class DocumentWatcher : IDisposable
{
    private readonly SolidWorksHost _sw;
    private readonly CvcPane _pane;
    private readonly Dictionary<string, Action> _unhook = new Dictionary<string, Action>(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, DateTime> _loadedAt = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

    public DocumentWatcher(SolidWorksHost sw, CvcPane pane)
    {
        _sw = sw;
        _pane = pane;
    }

    public void WatchOpenDocuments()
    {
        foreach (var document in _sw.OpenDocuments())
        {
            Watch(document);
        }
    }

    public void Dispose()
    {
        foreach (var unhook in _unhook.Values)
        {
            unhook();
        }
        _unhook.Clear();
    }

    private void Watch(ModelDoc2 document)
    {
        var path = SolidWorksHost.PathOf(document);
        if (path == null || _unhook.ContainsKey(path))
        {
            return;
        }
        _loadedAt[path] = DateTime.UtcNow;
        switch (document)
        {
            case PartDoc part:
                DPartDocEvents_FileSaveNotifyEventHandler partSave = _ => BeforeSave(path);
                DPartDocEvents_FileSavePostNotifyEventHandler partSaved = (_, _) => AfterSave();
                DPartDocEvents_ModifyNotifyEventHandler partModified = () => Modified(path);
                DPartDocEvents_DestroyNotify2EventHandler partDestroyed = type => Destroyed(path, type);
                part.FileSaveNotify += partSave;
                part.FileSavePostNotify += partSaved;
                part.ModifyNotify += partModified;
                part.DestroyNotify2 += partDestroyed;
                _unhook[path] = () =>
                {
                    part.FileSaveNotify -= partSave;
                    part.FileSavePostNotify -= partSaved;
                    part.ModifyNotify -= partModified;
                    part.DestroyNotify2 -= partDestroyed;
                };
                break;
            case AssemblyDoc assembly:
                DAssemblyDocEvents_FileSaveNotifyEventHandler assemblySave = _ => BeforeSave(path);
                DAssemblyDocEvents_FileSavePostNotifyEventHandler assemblySaved = (_, _) => AfterSave();
                DAssemblyDocEvents_ModifyNotifyEventHandler assemblyModified = () => Modified(path);
                DAssemblyDocEvents_DestroyNotify2EventHandler assemblyDestroyed = type => Destroyed(path, type);
                assembly.FileSaveNotify += assemblySave;
                assembly.FileSavePostNotify += assemblySaved;
                assembly.ModifyNotify += assemblyModified;
                assembly.DestroyNotify2 += assemblyDestroyed;
                _unhook[path] = () =>
                {
                    assembly.FileSaveNotify -= assemblySave;
                    assembly.FileSavePostNotify -= assemblySaved;
                    assembly.ModifyNotify -= assemblyModified;
                    assembly.DestroyNotify2 -= assemblyDestroyed;
                };
                break;
            case DrawingDoc drawing:
                DDrawingDocEvents_FileSaveNotifyEventHandler drawingSave = _ => BeforeSave(path);
                DDrawingDocEvents_FileSavePostNotifyEventHandler drawingSaved = (_, _) => AfterSave();
                DDrawingDocEvents_ModifyNotifyEventHandler drawingModified = () => Modified(path);
                DDrawingDocEvents_DestroyNotify2EventHandler drawingDestroyed = type => Destroyed(path, type);
                drawing.FileSaveNotify += drawingSave;
                drawing.FileSavePostNotify += drawingSaved;
                drawing.ModifyNotify += drawingModified;
                drawing.DestroyNotify2 += drawingDestroyed;
                _unhook[path] = () =>
                {
                    drawing.FileSaveNotify -= drawingSave;
                    drawing.FileSavePostNotify -= drawingSaved;
                    drawing.ModifyNotify -= drawingModified;
                    drawing.DestroyNotify2 -= drawingDestroyed;
                };
                break;
            default:
                break;
        }
    }

    // SolidWorks pre-notifications cancel the operation when the handler returns nonzero.
    private int BeforeSave(string path) => Guard(() => _pane.AllowSave(path) ? 0 : 1);

    private int AfterSave() => Guard(() =>
    {
        _pane.RefreshSoon();
        return 0;
    });

    private int Modified(string path) => Guard(() =>
    {
        // Opening a document can mark it changed (a rebuild, or converting an older file):
        // only offer a check-out for edits made after it finished loading.
        if (_loadedAt.TryGetValue(path, out var loaded) && DateTime.UtcNow - loaded > TimeSpan.FromSeconds(3))
        {
            _pane.DocumentModified(path);
        }
        return 0;
    });

    private int Destroyed(string path, int type) => Guard(() =>
    {
        if (type == (int)swDestroyNotifyType_e.swDestroyNotifyDestroy && _unhook.TryGetValue(path, out var unhook))
        {
            unhook();
            _unhook.Remove(path);
            _loadedAt.Remove(path);
        }
        return 0;
    });

    // An exception must never escape into SolidWorks.
    private static int Guard(Func<int> handler)
    {
        try
        {
            return handler();
        }
        catch (Exception e)
        {
            Log.Error("A document event handler failed", e);
            return 0;
        }
    }
}
