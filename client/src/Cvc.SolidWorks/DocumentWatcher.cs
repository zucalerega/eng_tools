using System;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Cvc.SolidWorks;

/// <summary>
/// Follows each open document's edits and saves, so CVC can offer to check a file out when
/// you start changing it, and explain why a file that isn't checked out won't save. Documents
/// are followed from when they're created or opened, and their file is looked up at each event:
/// a new document gets a path only when it's first saved, and Save As changes it.
/// </summary>
internal sealed class DocumentWatcher : IDisposable
{
    private readonly SolidWorksHost _sw;
    private readonly CvcPane _pane;
    // Keyed by the document itself, which SolidWorks keeps the same through saves and renames.
    private readonly Dictionary<ModelDoc2, Action> _unhook = new Dictionary<ModelDoc2, Action>();
    private readonly Dictionary<ModelDoc2, DateTime> _loadedAt = new Dictionary<ModelDoc2, DateTime>();

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
        if (_unhook.ContainsKey(document))
        {
            return;
        }
        _loadedAt[document] = DateTime.UtcNow;
        switch (document)
        {
            case PartDoc part:
                DPartDocEvents_FileSaveNotifyEventHandler partSave = _ => BeforeSave(document);
                DPartDocEvents_FileSaveAsNotify2EventHandler partSaveAs = _ => BeforeSaveAs(document);
                DPartDocEvents_FileSavePostNotifyEventHandler partSaved = (_, _) => AfterSave();
                DPartDocEvents_ModifyNotifyEventHandler partModified = () => Modified(document);
                DPartDocEvents_DestroyNotify2EventHandler partDestroyed = type => Destroyed(document, type);
                part.FileSaveNotify += partSave;
                part.FileSaveAsNotify2 += partSaveAs;
                part.FileSavePostNotify += partSaved;
                part.ModifyNotify += partModified;
                part.DestroyNotify2 += partDestroyed;
                _unhook[document] = () =>
                {
                    part.FileSaveNotify -= partSave;
                    part.FileSaveAsNotify2 -= partSaveAs;
                    part.FileSavePostNotify -= partSaved;
                    part.ModifyNotify -= partModified;
                    part.DestroyNotify2 -= partDestroyed;
                };
                break;
            case AssemblyDoc assembly:
                DAssemblyDocEvents_FileSaveNotifyEventHandler assemblySave = _ => BeforeSave(document);
                DAssemblyDocEvents_FileSaveAsNotify2EventHandler assemblySaveAs = _ => BeforeSaveAs(document);
                DAssemblyDocEvents_FileSavePostNotifyEventHandler assemblySaved = (_, _) => AfterSave();
                DAssemblyDocEvents_ModifyNotifyEventHandler assemblyModified = () => Modified(document);
                DAssemblyDocEvents_DestroyNotify2EventHandler assemblyDestroyed = type => Destroyed(document, type);
                assembly.FileSaveNotify += assemblySave;
                assembly.FileSaveAsNotify2 += assemblySaveAs;
                assembly.FileSavePostNotify += assemblySaved;
                assembly.ModifyNotify += assemblyModified;
                assembly.DestroyNotify2 += assemblyDestroyed;
                _unhook[document] = () =>
                {
                    assembly.FileSaveNotify -= assemblySave;
                    assembly.FileSaveAsNotify2 -= assemblySaveAs;
                    assembly.FileSavePostNotify -= assemblySaved;
                    assembly.ModifyNotify -= assemblyModified;
                    assembly.DestroyNotify2 -= assemblyDestroyed;
                };
                break;
            case DrawingDoc drawing:
                DDrawingDocEvents_FileSaveNotifyEventHandler drawingSave = _ => BeforeSave(document);
                DDrawingDocEvents_FileSaveAsNotify2EventHandler drawingSaveAs = _ => BeforeSaveAs(document);
                DDrawingDocEvents_FileSavePostNotifyEventHandler drawingSaved = (_, _) => AfterSave();
                DDrawingDocEvents_ModifyNotifyEventHandler drawingModified = () => Modified(document);
                DDrawingDocEvents_DestroyNotify2EventHandler drawingDestroyed = type => Destroyed(document, type);
                drawing.FileSaveNotify += drawingSave;
                drawing.FileSaveAsNotify2 += drawingSaveAs;
                drawing.FileSavePostNotify += drawingSaved;
                drawing.ModifyNotify += drawingModified;
                drawing.DestroyNotify2 += drawingDestroyed;
                _unhook[document] = () =>
                {
                    drawing.FileSaveNotify -= drawingSave;
                    drawing.FileSaveAsNotify2 -= drawingSaveAs;
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
    private int BeforeSave(ModelDoc2 document) =>
        Guard(() => SolidWorksHost.PathOf(document) is { } path && !_pane.AllowSave(path) ? 1 : 0);

    // Save on a read-only document (a vault file that isn't checked out to you) opens Save As
    // instead, without FileSaveNotify, so this is where CVC offers the check-out. Returning nonzero
    // skips the dialog: it then saves to the name set here, or not at all.
    private int BeforeSaveAs(ModelDoc2 document) => Guard(() =>
    {
        if (!SolidWorksHost.IsReadOnly(document) || SolidWorksHost.PathOf(document) is not { } path)
        {
            return 0; // an editable or new document: an ordinary Save As
        }
        switch (_pane.BeforeSaveAs(path))
        {
            case SaveAsChoice.SaveInPlace:
                SolidWorksHost.SaveToOwnFile(document, path);
                return 1;
            case SaveAsChoice.Cancel:
                return 1;
            default:
                return 0;
        }
    });

    private int AfterSave() => Guard(() =>
    {
        _pane.RefreshSoon();
        return 0;
    });

    private int Modified(ModelDoc2 document) => Guard(() =>
    {
        // Opening a document can mark it changed (a rebuild, or converting an older file):
        // only offer a check-out for edits made after it finished loading. A new document
        // has no file to check out until it's saved.
        if (SolidWorksHost.PathOf(document) is { } path
            && _loadedAt.TryGetValue(document, out var loaded) && DateTime.UtcNow - loaded > TimeSpan.FromSeconds(3))
        {
            _pane.DocumentModified(path);
        }
        return 0;
    });

    private int Destroyed(ModelDoc2 document, int type) => Guard(() =>
    {
        if (type == (int)swDestroyNotifyType_e.swDestroyNotifyDestroy && _unhook.TryGetValue(document, out var unhook))
        {
            unhook();
            _unhook.Remove(document);
            _loadedAt.Remove(document);
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
