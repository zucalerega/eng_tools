using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Cvc.Client;
using Timer = System.Windows.Forms.Timer;

namespace Cvc.SolidWorks;

/// <summary>
/// The CVC task pane: sign-in, the active document's status and actions, the workspace files that
/// need attention, and the whole vault to browse. It runs on SolidWorks' main thread and awaits
/// resume there, so SolidWorks calls after an await are safe. Workspace isn't thread-safe, so the
/// gate lets one operation run at a time.
/// </summary>
internal sealed class CvcPane : UserControl
{
    private static readonly Color Good = Color.FromArgb(26, 127, 55);
    private static readonly Color Attention = Color.FromArgb(154, 103, 0);
    private static readonly Color Problem = Color.FromArgb(207, 34, 46);

    private readonly SolidWorksHost _sw;
    private readonly AddinSettings _settings = AddinSettings.Load();
    private readonly TokenStore _tokens = new TokenStore();
    private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
    private readonly Timer _poll = new Timer { Interval = 20_000 };
    private readonly Timer _debounce = new Timer { Interval = 400 };
    private readonly HashSet<string> _offered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private Workspace? _workspace;
    private Account? _me;
    private VaultTree? _vault;
    private Dictionary<string, FileStatus> _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
    private string _shown = ""; // what the lists show, to redraw them only when it changes
    private bool _busy;
    private bool _doubleClicking;

    private readonly TextBox _serverBox = new TextBox { Dock = DockStyle.Fill };
    private readonly TextBox _rootBox = new TextBox { Dock = DockStyle.Fill };
    private readonly Button _signInButton;
    private readonly Control _setupView;

    private readonly Label _account = Caption("");
    private readonly Label _activeName = Heading("");
    private readonly Label _activeState = Caption("");
    private readonly Button _checkOutButton;
    private readonly Button _checkInButton;
    private readonly Button _undoButton;
    private readonly Button _getButton;
    private readonly Button _takeOverButton;
    private readonly Button _drawingButton;
    private readonly ListView _changes = new ListView
    {
        View = View.Details,
        FullRowSelect = true,
        HideSelection = false,
        Dock = DockStyle.Fill,
    };
    private readonly TreeView _tree = new TreeView { Dock = DockStyle.Fill, HideSelection = false, ShowNodeToolTips = true };
    private readonly TabControl _views = new TabControl { Dock = DockStyle.Fill, MinimumSize = new Size(0, 180) };
    private readonly Control _workView;
    private readonly Label _message = new Label { Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(0, 6, 0, 0) };

    public CvcPane(SolidWorksHost sw)
    {
        _sw = sw;
        SuspendLayout();
        Font = SystemFonts.MessageBoxFont;
        Padding = new Padding(8);

        _signInButton = MakeButton("Sign in", (_, _) => Safely(SignInAsync));
        _setupView = Stack(
            null,
            Heading("Vault"),
            Caption("Sign in to the team's Vault server to check SolidWorks files in and out."),
            Caption("Server address"),
            _serverBox,
            Caption("Workspace folder (use the same one on every computer)"),
            _rootBox,
            Row(_signInButton));

        _checkOutButton = MakeButton("Check out", (_, _) => OnActiveDocument(path => CheckOutAsync(new[] { path })));
        _checkInButton = MakeButton("Check in...", (_, _) => OnActiveDocument(path => CheckInAsync(new[] { path })));
        _undoButton = MakeButton("Undo check-out", (_, _) => OnActiveDocument(UndoAsync));
        _getButton = MakeButton("Get latest", (_, _) => OnActiveDocument(GetLatestAsync));
        _takeOverButton = MakeButton("Take over...", (_, _) => OnActiveDocument(TakeOverAsync));
        _drawingButton = MakeButton("Open drawing", (sender, _) => OnActiveDocument(path => OpenDrawingAsync(path, (Control)sender!)));
        _changes.Columns.Add("File");
        _changes.Columns.Add("State");
        _changes.Columns.Add("Checked out by");
        _changes.ClientSizeChanged += (_, _) => FitColumns();
        _changes.DoubleClick += (_, _) => Safely(() => OpenAsync(SelectedPaths()));
        _changes.ContextMenuStrip = ItemMenu();
        _tree.BeforeExpand += (_, e) => Guarded(() => Expanding(e));
        _tree.BeforeCollapse += (_, e) => e.Cancel = TakeDoubleClick();
        _tree.MouseDown += (_, e) => Guarded(() => PointAt(e));
        _tree.NodeMouseDoubleClick += (_, e) => Safely(() => OpenAsync(PathsOf(e.Node)));
        _tree.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && _tree.SelectedNode is { } node)
            {
                e.Handled = true;
                Safely(() => OpenAsync(PathsOf(node)));
            }
        };
        _tree.ContextMenuStrip = ItemMenu();
        _views.TabPages.Add(Page("Needs attention", _changes));
        _views.TabPages.Add(Page("Browse", _tree));
        _workView = Stack(
            _views,
            _account,
            Row(MakeButton("Open folder", (_, _) => OpenFolder()), MakeButton("Sign out", (_, _) => SignOut())),
            Heading("Active document"),
            _activeName,
            _activeState,
            Row(_checkOutButton, _checkInButton, _undoButton, _getButton, _takeOverButton, _drawingButton),
            _views,
            Row(
                MakeButton("Check in selected...", (_, _) => Safely(() => CheckInAsync(SelectedPaths()))),
                MakeButton("Get latest (everything)", (_, _) => Safely(GetEverythingAsync)),
                MakeButton("Refresh", (_, _) => RefreshSoon())));

        Controls.Add(_workView);
        Controls.Add(_setupView);
        Controls.Add(_message);
        // Sizes in this file are for a 100% (96 DPI) display. SolidWorks is DPI-aware, so Windows
        // doesn't scale the pane for us; this does, once the layout is built.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(false);
        PerformLayout();
        _poll.Tick += (_, _) => RefreshSoon();
        _debounce.Tick += async (_, _) =>
        {
            _debounce.Stop();
            await RefreshAsync();
        };
    }

    public void Start()
    {
        try
        {
            OpenWorkspace();
        }
        catch (Exception e) when (IsExpected(e))
        {
            Log.Error("Couldn't open the workspace", e);
            ShowMessage(e.Message, Problem);
        }
        _poll.Start();
        ShowActiveDocument();
        RefreshSoon();
    }

    public void RefreshSoon()
    {
        _debounce.Stop();
        _debounce.Start();
    }

    public void ActiveDocumentChanged()
    {
        ShowActiveDocument();
        RefreshSoon();
    }

    /// <summary>
    /// Called before SolidWorks saves a document; returning false cancels the save. A file that
    /// isn't checked out can be checked out on the spot if it's unlocked and up to date.
    /// </summary>
    public bool AllowSave(string path)
    {
        var workspace = _workspace;
        var status = StatusOf(path);
        if (workspace == null || status?.FileId == null || status.CheckedOutByMe)
        {
            return true; // not in the vault yet, or yours
        }
        var name = Path.GetFileName(path);
        if (status.Lock is { } other)
        {
            Warn($"{name} can't be saved: {other.User.Name} has it checked out on {other.Host}.");
            return false;
        }
        if (status.State is not (FileState.UpToDate or FileState.Modified))
        {
            Warn($"{name} can't be saved: a newer version is in the vault. Save your work under another name, then get the latest version.");
            return false;
        }
        return Ask($"{name} isn't checked out to you. Check it out now and save?") == DialogResult.Yes
            && CheckOutToSave(workspace, path);
    }

    /// <summary>
    /// Called before SolidWorks' Save As dialog for a read-only document. That's what Save opens for
    /// a vault file that isn't checked out to you (so AllowSave never sees it), and what File > Save As
    /// opens too. Offers to check the file out and save it in place, or to save under another name.
    /// </summary>
    public SaveAsChoice BeforeSaveAs(string path)
    {
        var workspace = _workspace;
        var status = StatusOf(path);
        if (workspace == null || status?.FileId == null)
        {
            return SaveAsChoice.ShowDialog; // not in the vault: an ordinary Save As
        }
        var name = Path.GetFileName(path);
        if (status.CheckedOutByMe)
        {
            // Checked out while it was open (with the CLI, say): it only needs to become editable.
            return _sw.SetReadOnly(path, false) ? SaveAsChoice.SaveInPlace : SaveAsChoice.ShowDialog;
        }
        var reason = status.Lock is { } other
            ? $"{name} is checked out by {other.User.Name} on {other.Host}, so your changes can't be saved to it."
            : status.State is not (FileState.UpToDate or FileState.Modified)
                ? $"{name} can't be saved: a newer version is in the vault."
                : null;
        if (reason != null)
        {
            return Ask(reason + " Save them under another name instead?") == DialogResult.Yes ? SaveAsChoice.ShowDialog : SaveAsChoice.Cancel;
        }
        var answer = MessageBox.Show(
            this,
            $"{name} isn't checked out to you.\n\nYes: check it out and save it.\nNo: save your changes under another name.",
            "Vault",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Question);
        return answer switch
        {
            DialogResult.Yes => CheckOutToSave(workspace, path) ? SaveAsChoice.SaveInPlace : SaveAsChoice.Cancel,
            DialogResult.No => SaveAsChoice.ShowDialog,
            _ => SaveAsChoice.Cancel,
        };
    }

    /// <summary>
    /// From the link listener's thread: open a cvc:// link from the web app. It's done on SolidWorks'
    /// thread, and this waits for it; the answer is what went wrong, or empty.
    /// </summary>
    public string OpenLinkFromAnotherThread(string link)
    {
        var done = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(new Action(async () =>
        {
            try
            {
                done.SetResult(await OpenLinkAsync(link));
            }
            catch (Exception e)
            {
                Log.Error("Opening a link from the web app failed", e);
                done.SetResult($"Something went wrong. Details are in {Log.FilePath}");
            }
        }));
        // A big assembly can take a while to download; the file still opens when it's done.
        return done.Task.Wait(TimeSpan.FromMinutes(10)) ? done.Task.Result : "";
    }

    private async Task<string> OpenLinkAsync(string link)
    {
        LinkRequest request;
        try
        {
            request = OpenLink.Parse(link);
        }
        catch (Exception e) when (e is WorkspaceException or VaultPathException)
        {
            return e.Message;
        }
        var workspace = _workspace;
        if (workspace == null)
        {
            return "Sign in to Vault in SolidWorks first: open the Vault tab in the task pane.";
        }
        if (!SameServer(workspace.Server, request.Server))
        {
            return $"That link is for the Vault server at {request.Server}, but this computer's workspace is for {workspace.Server}.";
        }
        var path = workspace.ToLocalPath(request.VaultPath);
        SolidWorksHost.BringToFront();
        if (request.Action == LinkAction.New)
        {
            await NewFileAsync(path, request.Model == null ? null : workspace.ToLocalPath(request.Model));
            SolidWorksHost.BringToFront();
            return ""; // what went wrong, if anything, is shown here in SolidWorks
        }
        await GetLatestAsync(path); // with the parts it uses; open copies update in place
        if (!File.Exists(path))
        {
            return $"{request.VaultPath} isn't in the vault, or you don't have access to it.";
        }
        _sw.Open(path);
        SolidWorksHost.BringToFront();
        return "";
    }

    /// <summary>
    /// Start a new part, assembly, or drawing (of model) at path, for the web app: SolidWorks makes it from
    /// its default template, and it's checked in at once, staying checked out to you, so everyone sees the
    /// name is taken. Changes to the model that you haven't checked in stay out of it.
    /// </summary>
    private Task NewFileAsync(string path, string? model) => RunAsync($"Starting {Path.GetFileName(path)}", async workspace =>
    {
        await workspace.CheckNewFileAsync(path);
        if (model != null)
        {
            // The drawing's view needs the model here, with the parts it uses.
            await GetLatestHereAsync(workspace, model);
            if (!File.Exists(model))
            {
                throw new WorkspaceException($"{Path.GetFileName(model)} isn't in the vault, or you don't have access to it.");
            }
        }
        if (_sw.CreateDocument(path, model) is { } problem)
        {
            throw new WorkspaceException(problem);
        }
        var uses = ReferenceMap(new[] { path });
        await workspace.CheckinAsync(
            new[] { path },
            "Started from the web app",
            keepCheckedOut: true,
            referencesOf: p => uses.TryGetValue(p, out var found) ? found : Array.Empty<string>(),
            withChangedReferences: false);
        return $"{Path.GetFileName(path)} is in the vault, checked out to you.";
    });

    /// <summary>The active document was changed: offer to check it out if it isn't yours (once per session).</summary>
    public void DocumentModified(string path)
    {
        if (_workspace == null
            || !string.Equals(path, _sw.ActiveDocumentPath, StringComparison.OrdinalIgnoreCase)
            || !_offered.Add(path))
        {
            return;
        }
        // Ask after SolidWorks' event returns, not inside it.
        BeginInvoke(new Action(() => Safely(() => OfferCheckoutAsync(path))));
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _poll.Dispose();
            _debounce.Dispose();
            _workspace?.Dispose();
            _gate.Dispose();
        }
        base.Dispose(disposing);
    }

    // --- actions ------------------------------------------------------------------------------

    private async Task SignInAsync()
    {
        var server = ParseServer(_serverBox.Text);
        var root = Path.GetFullPath(_rootBox.Text.Trim());
        var existing = Workspace.FindRoot(root);
        if (existing != null && !SameServer(Workspace.ServerOf(existing), server))
        {
            throw new WorkspaceException($"{existing} is a workspace for {Workspace.ServerOf(existing)}. Choose another folder.");
        }
        _signInButton.Enabled = false;
        try
        {
            ShowMessage("Finish signing in in your browser...", Attention);
            var issued = await BrowserSignIn.SignInAsync(
                server, $"SolidWorks add-in on {Environment.MachineName}", OpenInBrowser, TimeSpan.FromMinutes(5));
            _tokens.Save(server, issued.Token);
            if (existing == null)
            {
                Workspace.Create(root, server, issued.Token).Dispose();
            }
            _settings.WorkspaceRoot = existing ?? root;
            _settings.Server = server.AbsoluteUri;
            _settings.Save();
            OpenWorkspace();
            ShowMessage($"Signed in as {issued.User.Name}.", Good);
            RefreshSoon();
        }
        finally
        {
            _signInButton.Enabled = true;
        }
    }

    private void SignOut()
    {
        if (_workspace != null)
        {
            _tokens.Remove(_workspace.Server);
        }
        OpenWorkspace();
        ShowMessage("Signed out.", Attention);
    }

    private async Task OfferCheckoutAsync(string path)
    {
        var status = StatusOf(path);
        if (status?.FileId == null || status.CheckedOutByMe)
        {
            return;
        }
        var name = Path.GetFileName(path);
        if (status.Lock is { } other)
        {
            Warn($"{name} is checked out by {other.User.Name} on {other.Host}, so you won't be able to save changes to it.");
        }
        else if (Ask($"You're changing {name}, but it isn't checked out to you, so you won't be able to save. Check it out now?") == DialogResult.Yes)
        {
            await CheckOutAsync(new[] { path });
        }
    }

    /// <summary>Take over a check-out on another computer (see Workspace.CanTakeOver), after asking.</summary>
    private async Task TakeOverAsync(string path)
    {
        if (_workspace == null || StatusOf(path) is not { Lock: { } other } status || !_workspace.CanTakeOver(status))
        {
            return;
        }
        var name = Path.GetFileName(path);
        var question = other.User.Id == _me?.Id
            ? $"Move your check-out of {name} from {other.Host} to this computer? Changes you made on {other.Host} stay there."
            : $"Take over {other.User.Name}'s check-out of {name}? It will be checked out to you here, and their check-out ends. "
                + $"Their changes stay on {other.Host}, and Vault tells them what happened if they try to check in.";
        if (Ask(question) == DialogResult.Yes)
        {
            await CheckOutAsync(new[] { path }, force: true);
        }
    }

    private Task CheckOutAsync(IReadOnlyList<string> paths, bool force = false) => RunAsync("Checking out", async workspace =>
    {
        // Checking out an out-of-date file downloads the latest version first, over the open document.
        var outdated = (await CurrentStatusAsync(workspace, paths)).Where(s => s.State == FileState.Outdated).Select(s => s.LocalPath).ToList();
        RefuseUnsaved(outdated, "check out");
        await ReplacingAsync(outdated, () => workspace.CheckoutAsync(paths, force));
        foreach (var path in paths)
        {
            _sw.SetReadOnly(path, false);
        }
        return paths.Count == 1 ? $"Checked out {Path.GetFileName(paths[0])}." : $"Checked out {Count(paths.Count, "file")}.";
    });

    private async Task CheckInAsync(IReadOnlyList<string> paths)
    {
        if (_workspace == null || paths.Count == 0)
        {
            return;
        }
        // Check in what's on screen: save open documents first.
        var unsaved = _sw.OpenDocuments().Select(SolidWorksHost.PathOf)
            .Where(p => p != null && IsInWorkspace(p) && _sw.HasUnsavedChanges(p)).Cast<string>().ToList();
        if (unsaved.Count > 0)
        {
            var answer = MessageBox.Show(
                this,
                "Save changes before checking in?\n\n" + string.Join("\n", unsaved.Select(Path.GetFileName)),
                "Vault",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question);
            if (answer == DialogResult.Cancel)
            {
                return;
            }
            if (answer == DialogResult.Yes)
            {
                unsaved.ForEach(p => _sw.Save(p));
            }
        }
        using var dialog = new CheckinDialog(paths.Select(Path.GetFileName));
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }
        // Ask SolidWorks what each file uses now, on this thread; check-in reads it on another.
        var uses = ReferenceMap(paths);
        await RunAsync("Checking in", async workspace =>
        {
            var result = await workspace.CheckinAsync(
                paths, dialog.Comment, dialog.KeepCheckedOut,
                path => uses.TryGetValue(path, out var found) ? found : Array.Empty<string>());
            foreach (var file in result.Files.Where(f => f.File.CheckedOut == null))
            {
                _sw.SetReadOnly(workspace.ToLocalPath(file.File.Path), true);
            }
            return $"Checked in {Count(result.Files.Count, "file")}.";
        });
    }

    private Task UndoAsync(string path) => RunAsync("Undoing the check-out", async workspace =>
    {
        var name = Path.GetFileName(path);
        // What's on disk now: a save a moment ago may not be in the last refresh.
        var replaced = (await CurrentStatusAsync(workspace, new[] { path })).Any(s => s.State is FileState.Modified or FileState.Conflict or FileState.Outdated);
        var changed = replaced || _sw.HasUnsavedChanges(path);
        if (changed && Ask($"Undo the check-out of {name} and throw away your changes? A copy is kept in {workspace.Root}\\.cvc\\backup.") != DialogResult.Yes)
        {
            return null;
        }
        // You've agreed to lose unsaved changes too, so the document is reloaded regardless.
        var result = await ReplacingAsync(changed ? new[] { path } : Array.Empty<string>(), () => workspace.UndoCheckoutAsync(new[] { path }), discardChanges: true);
        _sw.SetReadOnly(path, true);
        return result.BackedUp.Count > 0 ? $"Undone. Your changes were saved to {result.BackedUp[0]}." : $"Undid the check-out of {name}.";
    });

    private Task GetLatestAsync(string path) =>
        RunAsync("Getting the latest version", async workspace => Summary(await GetLatestHereAsync(workspace, path)));

    // The file and the parts it uses are updated in place, open or not.
    private async Task<GetResult> GetLatestHereAsync(Workspace workspace, string path)
    {
        var involved = new List<string> { path };
        involved.AddRange(_sw.AllReferences(path));
        var stale = (await CurrentStatusAsync(workspace, involved)).Where(s => s.State == FileState.Outdated).Select(s => s.LocalPath).ToList();
        RefuseUnsaved(stale, "get the latest version");
        return await ReplacingAsync(stale, () => workspace.GetLatestAsync(new[] { path }));
    }

    private Task GetEverythingAsync() =>
        RunAsync("Getting the latest versions", async workspace => Summary(await GetLatestUpdatingOpenAsync(workspace, null)));

    /// <summary>
    /// Get the latest versions of these files (or everything), updating open documents in place. Open
    /// documents with unsaved changes are left alone and show up as files that couldn't be updated.
    /// </summary>
    private async Task<GetResult> GetLatestUpdatingOpenAsync(Workspace workspace, IReadOnlyList<string>? paths)
    {
        var open = _sw.OpenDocuments().Select(SolidWorksHost.PathOf).Where(p => p != null).Cast<string>();
        var stale = (await CurrentStatusAsync(workspace, open))
            .Where(s => s.State == FileState.Outdated && !_sw.HasUnsavedChanges(s.LocalPath)).Select(s => s.LocalPath).ToList();
        return await ReplacingAsync(stale, () => workspace.GetLatestAsync(paths));
    }

    // --- plumbing -----------------------------------------------------------------------------

    /// <summary>
    /// Run one operation at a time with the UI disabled. Errors are shown, never thrown: an
    /// exception escaping into SolidWorks' message loop could crash it.
    /// </summary>
    private async Task RunAsync(string doing, Func<Workspace, Task<string?>> action)
    {
        var workspace = _workspace;
        if (workspace == null)
        {
            return;
        }
        await _gate.WaitAsync();
        SetBusy(true);
        ShowMessage(doing + "...", Attention);
        try
        {
            ShowMessage(await action(workspace) ?? "", Good);
        }
        catch (CvcApiException e) when (e.StatusCode == 401)
        {
            _tokens.Remove(workspace.Server);
            OpenWorkspace();
            ShowMessage("Your sign-in expired. Sign in again.", Attention);
        }
        catch (Exception e) when (IsExpected(e))
        {
            Log.Error(doing + " failed", e);
            ShowMessage(e.Message, Problem);
            Warn(e.Message);
        }
        catch (Exception e)
        {
            Log.Error(doing + " failed", e);
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Problem);
        }
        finally
        {
            SetBusy(false);
            _gate.Release();
        }
        await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        var workspace = _workspace;
        if (workspace == null || !_gate.Wait(0))
        {
            return;
        }
        try
        {
            var me = _me = await workspace.WhoAmIAsync();
            var vault = _vault = await workspace.BrowseAsync();
            _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
            foreach (var status in vault.Files)
            {
                _statuses[VaultPaths.Key(status.VaultPath)] = status;
            }
            _account.Text = $"{me.Name} ({me.Email}) on {workspace.Host}\n{workspace.Server}\n{workspace.Root}";
            // Redrawn only when something changed, so a refresh doesn't close what you had open in the tree.
            var shown = Signature(vault);
            if (shown != _shown)
            {
                _shown = shown;
                ShowChanges(vault.Files);
                ShowBrowse(vault);
            }
            ShowActiveDocument();
        }
        catch (CvcApiException e) when (e.StatusCode == 401)
        {
            _tokens.Remove(workspace.Server);
            OpenWorkspace();
            ShowMessage("Your sign-in expired. Sign in again.", Attention);
        }
        catch (Exception e) when (IsExpected(e))
        {
            ShowMessage("Couldn't refresh: " + e.Message, Problem);
        }
        catch (Exception e)
        {
            Log.Error("Refresh failed", e);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Run a workspace operation that replaces these files while they're open in SolidWorks, which
    /// holds them (and closing a part isn't enough when an open assembly uses it). SolidWorks lets go
    /// of them first and reloads them after, so windows stay put and assemblies update. Unsaved changes
    /// are thrown away only with discardChanges, when the user has agreed to that.
    /// </summary>
    private async Task<T> ReplacingAsync<T>(IReadOnlyCollection<string> files, Func<Task<T>> operation, bool discardChanges = false)
    {
        var released = _sw.Release(files);
        try
        {
            return await operation();
        }
        finally
        {
            var kept = released.Reload(discardChanges);
            if (kept.Count > 0)
            {
                Warn($"{string.Join(", ", kept.Select(Path.GetFileName))} changed while Vault was updating it, so SolidWorks still shows "
                    + "the old version, with your changes. Save them under another name, then close and reopen the file to see the latest version.");
            }
        }
    }

    // A file about to be replaced with the latest version can't have unsaved changes: they'd be lost.
    private void RefuseUnsaved(IEnumerable<string> replaced, string then)
    {
        var unsaved = replaced.Where(_sw.HasUnsavedChanges).Select(Path.GetFileName).ToList();
        if (unsaved.Count > 0)
        {
            throw new WorkspaceException(
                $"{string.Join(", ", unsaved)} {(unsaved.Count == 1 ? "has" : "have")} unsaved changes, and there's a newer version in the vault. "
                + $"Close without saving, or save your changes under another name, then {then}.");
        }
    }

    // The vault's state for these files now, not at the last refresh. Files outside the workspace have none.
    private async Task<IReadOnlyList<FileStatus>> CurrentStatusAsync(Workspace workspace, IEnumerable<string> paths)
    {
        var inside = paths.Where(IsInWorkspace).ToList();
        return inside.Count == 0 ? Array.Empty<FileStatus>() : await workspace.StatusAsync(inside);
    }

    /// <summary>
    /// Check out a file SolidWorks is about to save, and make its document editable. SolidWorks is
    /// waiting on its save event, so this runs synchronously (off this thread).
    /// </summary>
    private bool CheckOutToSave(Workspace workspace, string path)
    {
        if (!_gate.Wait(0))
        {
            Warn("Vault is busy. Try saving again in a moment.");
            return false;
        }
        try
        {
            // The last refresh can be a minute old: if a newer version was checked in since, checking out
            // would replace the file under your unsaved changes.
            var current = Task.Run(() => workspace.StatusAsync(new[] { path })).GetAwaiter().GetResult().FirstOrDefault();
            if (current?.State is not (FileState.UpToDate or FileState.Modified))
            {
                Warn($"{Path.GetFileName(path)} can't be saved: a newer version is in the vault. Save your work under another name, then get the latest version.");
                return false;
            }
            var checkedOut = Task.Run(() => workspace.CheckoutAsync(new[] { path })).GetAwaiter().GetResult();
            // SolidWorks asks AllowSave next, so it has to see the check-out now, not after the next refresh.
            foreach (var status in checkedOut)
            {
                _statuses[VaultPaths.Key(status.VaultPath)] = status;
            }
            if (!_sw.SetReadOnly(path, false))
            {
                Warn($"{Path.GetFileName(path)} is checked out to you now, but SolidWorks kept it read-only. Close it, open it again, and save.");
                return false;
            }
            return true;
        }
        catch (Exception e) when (IsExpected(e))
        {
            Log.Error("Check-out before saving failed", e);
            Warn(e.Message);
            return false;
        }
        finally
        {
            _gate.Release();
            RefreshSoon();
        }
    }

    // Button and menu handlers: nothing may escape into SolidWorks.
    private async void Safely(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception e) when (IsExpected(e) || e is UriFormatException)
        {
            ShowMessage(e.Message, Problem);
        }
        catch (Exception e)
        {
            Log.Error("A task pane action failed", e);
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Problem);
        }
    }

    // The same, for handlers that must finish before they return (a tree node about to open).
    private void Guarded(Action action)
    {
        try
        {
            action();
        }
        catch (Exception e)
        {
            Log.Error("A task pane action failed", e);
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Problem);
        }
    }

    private void OnActiveDocument(Func<string, Task> action)
    {
        var path = _sw.ActiveDocumentPath;
        if (path != null)
        {
            Safely(() => action(path));
        }
    }

    private static bool IsExpected(Exception e) =>
        e is CvcApiException or WorkspaceException or VaultPathException or HttpRequestException
            or TimeoutException or TaskCanceledException or IOException or UnauthorizedAccessException or JsonException;

    private void OpenWorkspace()
    {
        _workspace?.Dispose();
        _workspace = null;
        _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
        Uri? server = null;
        var root = Workspace.FindRoot(_settings.WorkspaceRoot);
        if (root != null)
        {
            server = Workspace.ServerOf(root);
            var token = _tokens.Load(server);
            if (token != null)
            {
                _workspace = Workspace.Open(root, token);
            }
        }
        _serverBox.Text = server?.AbsoluteUri ?? _settings.Server ?? "";
        _rootBox.Text = root ?? _settings.WorkspaceRoot;
        _setupView.Visible = _workspace == null;
        _workView.Visible = _workspace != null;
        _vault = null;
        _shown = "";
        _changes.Items.Clear();
        _tree.Nodes.Clear();
        ShowActiveDocument();
    }

    private Dictionary<string, IReadOnlyList<string>> ReferenceMap(IEnumerable<string> roots)
    {
        var map = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>(roots);
        while (pending.Count > 0)
        {
            var path = pending.Pop();
            if (map.ContainsKey(path))
            {
                continue;
            }
            var uses = _sw.References(path);
            map[path] = uses;
            foreach (var used in uses)
            {
                pending.Push(used);
            }
        }
        return map;
    }

    private bool IsInWorkspace(string path) =>
        _workspace != null
        && path.StartsWith(_workspace.Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private FileStatus? StatusOf(string path)
    {
        if (_workspace == null || !IsInWorkspace(path))
        {
            return null;
        }
        try
        {
            return _statuses.TryGetValue(VaultPaths.Key(_workspace.ToVaultPath(path)), out var status) ? status : null;
        }
        catch (Exception e) when (e is VaultPathException or WorkspaceException)
        {
            return null;
        }
    }

    // What's selected on the tab that's showing: files, or in Browse a file or a folder.
    private List<string> SelectedPaths()
    {
        if (!BrowseShown)
        {
            return _changes.SelectedItems.Cast<ListViewItem>().Select(i => ((FileStatus)i.Tag).LocalPath).ToList();
        }
        return _tree.SelectedNode?.Tag switch
        {
            BrowseItem item => new List<string> { item.File.LocalPath },
            TreeFolder folder when _workspace != null => new List<string> { _workspace.ToLocalPath(folder.VaultPath) },
            _ => new List<string>(),
        };
    }

    private List<FileStatus> SelectedStatuses() => BrowseShown
        ? _tree.SelectedNode?.Tag is BrowseItem item ? new List<FileStatus> { item.File } : new List<FileStatus>()
        : _changes.SelectedItems.Cast<ListViewItem>().Select(i => (FileStatus)i.Tag).ToList();

    private bool BrowseShown => _views.SelectedTab?.Controls.Contains(_tree) == true;

    // --- showing ------------------------------------------------------------------------------

    private void ShowActiveDocument()
    {
        var path = _sw.ActiveDocumentPath;
        var status = path == null ? null : StatusOf(path);
        _activeName.Text = path == null ? "No document open" : Path.GetFileName(path);
        (_activeState.Text, _activeState.ForeColor) = Describe(path, status);
        var inVault = status?.FileId != null;
        _checkOutButton.Enabled = !_busy && inVault && status!.Lock == null
            && status.State is FileState.UpToDate or FileState.Outdated or FileState.Modified;
        _checkInButton.Enabled = !_busy && status != null && (status.State == FileState.New || status.CheckedOutByMe);
        _undoButton.Enabled = !_busy && status?.CheckedOutByMe == true;
        _getButton.Enabled = !_busy && inVault;
        // Only where you may: most people never see it.
        _takeOverButton.Visible = status != null && _workspace?.CanTakeOver(status) == true;
        _takeOverButton.Enabled = !_busy;
        _drawingButton.Visible = status != null && _vault?.Drawings(status).Count > 0;
        _drawingButton.Enabled = !_busy;
    }

    private (string Text, Color Color) Describe(string? path, FileStatus? status)
    {
        if (path == null || _workspace == null)
        {
            return ("", ForeColor);
        }
        if (!IsInWorkspace(path))
        {
            return ($"Not in the Vault workspace. Save it under {_workspace.Root} to version it.", Attention);
        }
        if (status == null)
        {
            return ("Not checked in yet (refreshing...)", ForeColor);
        }
        var version = status.RemoteVersion is int v ? $"v{v}: " : "";
        return status switch
        {
            { CheckedOutByMe: true, State: FileState.Modified } => (version + "checked out to you, with changes", Good),
            { CheckedOutByMe: true } => (version + "checked out to you", Good),
            { Lock: { } other } => (version + $"checked out by {other.User.Name} on {other.Host}", Attention),
            { State: FileState.New } => ("New: check it in to add it to the vault", Attention),
            { State: FileState.UpToDate } => (version + "up to date; read-only until you check it out", ForeColor),
            { State: FileState.Outdated } => ($"v{status.LocalVersion} here, v{status.RemoteVersion} in the vault: get the latest", Attention),
            { State: FileState.Modified } => (version + "changed, but not checked out: check it out to keep your changes", Attention),
            { State: FileState.Conflict } => ("Conflict: changed here, but someone checked in a newer version", Problem),
            { State: FileState.DeletedInVault } => ("Deleted in the vault", Problem),
            _ => (status.State.ToString(), ForeColor),
        };
    }

    private void ShowChanges(IReadOnlyList<FileStatus> statuses)
    {
        var attention = statuses
            .Where(s => s.Lock != null || s.State is FileState.New or FileState.Modified or FileState.Conflict or FileState.Outdated or FileState.DeletedInVault)
            .OrderBy(s => s.CheckedOutByMe ? 0 : s.State == FileState.New ? 1 : 2)
            .ThenBy(s => s.VaultPath, StringComparer.OrdinalIgnoreCase);
        var selected = new HashSet<string>(
            _changes.SelectedItems.Cast<ListViewItem>().Select(i => ((FileStatus)i.Tag).VaultPath), StringComparer.OrdinalIgnoreCase);
        _changes.BeginUpdate();
        _changes.Items.Clear();
        foreach (var status in attention)
        {
            var who = status.Lock == null ? "" : status.CheckedOutByMe ? "you" : $"{status.Lock.User.Name} ({status.Lock.Host})";
            _changes.Items.Add(new ListViewItem(new[] { status.VaultPath, StateText(status.State), who })
            {
                Tag = status,
                ForeColor = status.State is FileState.Conflict or FileState.DeletedInVault ? Problem
                    : status.State == FileState.Outdated || (status.Lock != null && !status.CheckedOutByMe) ? Attention
                    : _changes.ForeColor,
                Selected = selected.Contains(status.VaultPath),
            });
        }
        _changes.EndUpdate();
    }

    // The task pane's width depends on SolidWorks and the display, so the columns share whatever
    // width the list has instead of overflowing it (at 100%) or leaving most of it empty (at 250%).
    private void FitColumns()
    {
        var width = _changes.ClientSize.Width;
        _changes.Columns[0].Width = width / 2;
        _changes.Columns[1].Width = width / 5;
        _changes.Columns[2].Width = width - _changes.Columns[0].Width - _changes.Columns[1].Width;
    }

    private static string StateText(FileState state) => state switch
    {
        FileState.New => "new",
        FileState.Modified => "changed",
        FileState.Conflict => "conflict",
        FileState.Outdated => "out of date",
        FileState.DeletedInVault => "deleted in vault",
        FileState.Missing => "not downloaded",
        _ => "up to date",
    };

    private static string Summary(GetResult result)
    {
        var parts = new List<string> { $"Got {Count(result.Downloaded.Count, "file")}." };
        if (result.Skipped.Count > 0)
        {
            parts.Add($"Skipped {Count(result.Skipped.Count, "file")} changed here (use the CLI's get --force to replace them).");
        }
        if (result.Failures.Count > 0)
        {
            parts.Add("Couldn't update: " + string.Join("; ", result.Failures));
        }
        return string.Join(" ", parts);
    }

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";

    private void SetBusy(bool busy)
    {
        _busy = busy;
        UseWaitCursor = busy;
        _views.Enabled = !busy;
        ShowActiveDocument();
    }

    private void ShowMessage(string text, Color color)
    {
        _message.Text = text;
        _message.ForeColor = color;
    }

    private void Warn(string text) => MessageBox.Show(this, text, "Vault", MessageBoxButtons.OK, MessageBoxIcon.Warning);

    private DialogResult Ask(string question) => MessageBox.Show(this, question, "Vault", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

    /// <summary>Open files, SolidWorks' own in SolidWorks. One that isn't here yet is got first, with the parts it uses.</summary>
    private async Task OpenAsync(IReadOnlyList<string> paths)
    {
        foreach (var path in paths)
        {
            if (!File.Exists(path) && StatusOf(path)?.FileId != null)
            {
                await GetLatestAsync(path);
            }
            if (!File.Exists(path))
            {
                continue;
            }
            if (SolidWorksHost.IsSolidWorksFile(path))
            {
                _sw.Open(path);
            }
            else
            {
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
        }
    }

    // A part's or assembly's drawing: the one it has, or a choice of them, under the button.
    private Task OpenDrawingAsync(string path, Control button)
    {
        var drawings = StatusOf(path) is { } status && _vault != null ? _vault.Drawings(status) : Array.Empty<FileStatus>();
        if (drawings.Count == 1)
        {
            return OpenAsync(new[] { drawings[0].LocalPath });
        }
        if (drawings.Count > 1)
        {
            var choice = new ContextMenuStrip();
            foreach (var drawing in drawings)
            {
                var local = drawing.LocalPath;
                choice.Items.Add(NameOf(drawing.VaultPath), null, (_, _) => Safely(() => OpenAsync(new[] { local })));
            }
            choice.Closed += (_, _) => BeginInvoke(new Action(choice.Dispose));
            choice.Show(button, new Point(0, button.Height));
        }
        return Task.CompletedTask;
    }

    private void OpenFolder()
    {
        if (_workspace != null)
        {
            Process.Start("explorer.exe", "\"" + _workspace.Root + "\"");
        }
    }

    private static void OpenInBrowser(Uri url) => Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });

    private static Uri ParseServer(string text) =>
        Uri.TryCreate(text.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            ? uri
            : throw new WorkspaceException("Enter the server's address, like https://cvc.example.org");

    private static bool SameServer(Uri a, Uri b) =>
        string.Equals(a.AbsoluteUri.TrimEnd('/'), b.AbsoluteUri.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);

    /// <summary>Right-click actions on what's selected in the list or the tree (a folder in the tree gets its own few).</summary>
    private ContextMenuStrip ItemMenu()
    {
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("Open", null, (_, _) => Safely(() => OpenAsync(SelectedPaths())));
        var drawing = new ToolStripMenuItem("Open drawing");
        menu.Items.Add(drawing);
        var checkOut = menu.Items.Add("Check out", null, (_, _) => Safely(() => CheckOutAsync(SelectedPaths())));
        var checkIn = menu.Items.Add("Check in...", null, (_, _) => Safely(() => CheckInAsync(SelectedPaths())));
        var undo = menu.Items.Add("Undo check-out", null, (_, _) => Safely(() => UndoAsync(SelectedPaths()[0])));
        var get = menu.Items.Add("Get latest", null, (_, _) => Safely(() => RunAsync("Getting the latest versions", async workspace =>
            Summary(await GetLatestUpdatingOpenAsync(workspace, SelectedPaths())))));
        var takeOver = menu.Items.Add("Take over...", null, (_, _) => Safely(() => TakeOverAsync(SelectedPaths()[0])));
        var explorer = menu.Items.Add("Show in File Explorer", null, (_, _) => Guarded(() => ShowInExplorer(SelectedPaths())));
        menu.Opening += (_, e) =>
        {
            var files = SelectedStatuses();
            var folder = BrowseShown && _tree.SelectedNode?.Tag is TreeFolder;
            if (files.Count == 0 && !folder)
            {
                e.Cancel = true;
                return;
            }
            open.Available = checkOut.Available = undo.Available = takeOver.Available = !folder;
            explorer.Available = folder;
            open.Enabled = !_busy;
            checkOut.Enabled = !_busy && files.Any(s => s.FileId != null && s.Lock == null
                && s.State is FileState.UpToDate or FileState.Outdated or FileState.Modified or FileState.Missing);
            checkIn.Enabled = !_busy && (folder || files.Any(s => s.State == FileState.New || s.CheckedOutByMe));
            undo.Enabled = !_busy && files.Count == 1 && files[0].CheckedOutByMe;
            get.Enabled = !_busy && (folder || files.Any(s => s.FileId != null));
            takeOver.Available = takeOver.Available && files.Count == 1 && _workspace?.CanTakeOver(files[0]) == true;
            takeOver.Enabled = !_busy;
            drawing.DropDownItems.Clear();
            foreach (var shows in files.Count == 1 && _vault != null ? _vault.Drawings(files[0]) : Array.Empty<FileStatus>())
            {
                var local = shows.LocalPath;
                drawing.DropDownItems.Add(NameOf(shows.VaultPath), null, (_, _) => Safely(() => OpenAsync(new[] { local })));
            }
            drawing.Available = !folder && drawing.DropDownItems.Count > 0;
            drawing.Enabled = !_busy;
        };
        return menu;
    }

    // A vault folder in File Explorer: made here first if it has nothing here yet, so new files can go in it.
    private static void ShowInExplorer(IReadOnlyList<string> folders)
    {
        foreach (var folder in folders)
        {
            Directory.CreateDirectory(folder);
            Process.Start("explorer.exe", "\"" + folder + "\"");
        }
    }

    // --- browsing -----------------------------------------------------------------------------

    /// <summary>A file in the Browse tree: in its folder, used by an assembly, or a model's drawing.</summary>
    private sealed class BrowseItem
    {
        public BrowseItem(FileStatus file) => File = file;

        public FileStatus File { get; }
    }

    // Stands in for what's under a tree node until it's opened.
    private static readonly object Unfilled = new object();

    /// <summary>
    /// Draw the Browse tree from a refresh, with the same folders and assemblies open, the same node
    /// selected, and the same place scrolled to. What's under a node is filled in when it's opened.
    /// </summary>
    private void ShowBrowse(VaultTree vault)
    {
        var open = new List<string>();
        OpenKeys(_tree.Nodes, open);
        var selected = _tree.SelectedNode?.Name;
        var top = _tree.TopNode?.Name;
        _tree.BeginUpdate();
        try
        {
            _tree.Nodes.Clear();
            AddFolderContents(_tree.Nodes, vault.Root);
            foreach (var key in open)
            {
                NodeNamed(key)?.Expand();
            }
            if (selected != null && NodeNamed(selected) is { } node)
            {
                _tree.SelectedNode = node;
            }
            if (top != null && NodeNamed(top) is { } first)
            {
                _tree.TopNode = first;
            }
        }
        finally
        {
            _tree.EndUpdate();
        }
    }

    private static void OpenKeys(TreeNodeCollection nodes, List<string> keys)
    {
        foreach (TreeNode node in nodes)
        {
            if (node.IsExpanded)
            {
                keys.Add(node.Name);
                OpenKeys(node.Nodes, keys);
            }
        }
    }

    private TreeNode? NodeNamed(string key) => key.Length == 0 ? null : _tree.Nodes.Find(key, searchAllChildren: true).FirstOrDefault();

    private void AddFolderContents(TreeNodeCollection nodes, TreeFolder folder)
    {
        foreach (var child in folder.Folders)
        {
            var node = nodes.Add("d:" + VaultPaths.Key(child.VaultPath), child.CheckedOut > 0 ? $"{child.Name}   ({child.CheckedOut} checked out)" : child.Name);
            node.Tag = child;
            node.ToolTipText = child.VaultPath;
            if (child.Folders.Count + child.Files.Count > 0)
            {
                node.Nodes.Add(new TreeNode("...") { Tag = Unfilled });
            }
        }
        foreach (var file in folder.Files)
        {
            nodes.Add(FileNode(file, "f:" + (file.FileId?.ToString(CultureInfo.InvariantCulture) ?? VaultPaths.Key(file.VaultPath))));
        }
    }

    /// <summary>
    /// A file's node, saying whether it's checked in. Under another file (user: the assembly that uses it, or
    /// the model a drawing shows) it also says which version that one was checked in with, and where it's kept.
    /// </summary>
    private TreeNode FileNode(FileStatus file, string key, UsedStatus? used = null, FileStatus? user = null, bool drawing = false)
    {
        var text = new StringBuilder(drawing ? "Drawing: " : "").Append(NameOf(file.VaultPath));
        if (user != null && FolderOf(file.VaultPath) != FolderOf(user.VaultPath))
        {
            text.Append("  (in ").Append(FolderOf(file.VaultPath)).Append(')');
        }
        var version = used == null
            ? file.RemoteVersion is int latest ? $"v{latest}" : ""
            : file.RemoteVersion is int now && now != used.Version ? $"v{used.Version} (now v{now})" : $"v{used.Version}";
        text.Append("   ").Append(version.Length > 0 ? version + " · " : "").Append(BrowseState(file));
        var node = new TreeNode(text.ToString()) { Name = key, Tag = new BrowseItem(file), ForeColor = ColorOf(file), ToolTipText = TipFor(file) };
        // A drawing listed under its model is a link to it: what it shows is already there, above it.
        if (!drawing && _vault != null && ((_vault.Uses(file)?.Count ?? 0) > 0 || _vault.Drawings(file).Count > 0))
        {
            node.Nodes.Add(new TreeNode("...") { Tag = Unfilled });
        }
        return node;
    }

    // Fill in what's under a node as it opens: a folder's folders and files, or what a file uses and its drawings.
    private void Expanding(TreeViewCancelEventArgs e)
    {
        if (TakeDoubleClick())
        {
            e.Cancel = true;
            return;
        }
        var node = e.Node;
        if (_vault == null || node.Nodes.Count != 1 || node.Nodes[0].Tag != Unfilled)
        {
            return;
        }
        node.Nodes.Clear();
        if (node.Tag is TreeFolder folder)
        {
            AddFolderContents(node.Nodes, folder);
            return;
        }
        if (node.Tag is not BrowseItem item)
        {
            return;
        }
        // A file can't use itself, but a vault might say one does: don't follow a file already on the way here.
        var trail = new HashSet<long>();
        for (var up = node; up != null; up = up.Parent)
        {
            if (up.Tag is BrowseItem { File.FileId: long id })
            {
                trail.Add(id);
            }
        }
        foreach (var used in _vault.Uses(item.File) ?? Array.Empty<UsedStatus>())
        {
            if (used.File == null)
            {
                node.Nodes.Add(new TreeNode("A file deleted from the vault") { Name = $"{node.Name}/{used.FileId}", ForeColor = SystemColors.GrayText });
            }
            else if (!trail.Contains(used.FileId))
            {
                node.Nodes.Add(FileNode(used.File, $"{node.Name}/{used.FileId}", used, item.File));
            }
        }
        foreach (var shows in _vault.Drawings(item.File))
        {
            if (shows.FileId is long id && !trail.Contains(id))
            {
                node.Nodes.Add(FileNode(shows, $"{node.Name}/d{id}", user: item.File, drawing: true));
            }
        }
    }

    // Double-clicking a file opens it, rather than opening or closing it in the tree; right-clicking selects.
    private void PointAt(MouseEventArgs e)
    {
        var node = _tree.GetNodeAt(e.Location);
        _doubleClicking = e.Clicks > 1 && node?.Tag is BrowseItem;
        if (e.Button == MouseButtons.Right && node != null)
        {
            _tree.SelectedNode = node;
        }
    }

    private bool TakeDoubleClick()
    {
        var was = _doubleClicking;
        _doubleClicking = false;
        return was;
    }

    private IReadOnlyList<string> PathsOf(TreeNode node)
    {
        _doubleClicking = false;
        return node.Tag is BrowseItem item ? new[] { item.File.LocalPath } : Array.Empty<string>();
    }

    private static string BrowseState(FileStatus file) => file switch
    {
        { State: FileState.New } => "new: not checked in yet",
        { State: FileState.DeletedInVault } => "deleted in the vault",
        { CheckedOutByMe: true, State: FileState.Modified } => "checked out to you, changed",
        { CheckedOutByMe: true } => "checked out to you",
        { Lock: { } other } => $"checked out by {other.User.Name} on {other.Host}",
        { State: FileState.Outdated } => "checked in; a newer version is in the vault",
        { State: FileState.Missing } => "checked in; not downloaded here",
        { State: FileState.Modified } => "checked in; changed here",
        { State: FileState.Conflict } => "checked in; conflict: changed here and in the vault",
        _ => "checked in",
    };

    private Color ColorOf(FileStatus file) => file switch
    {
        { State: FileState.Conflict or FileState.DeletedInVault } => Problem,
        { CheckedOutByMe: true } => Good,
        { Lock: not null } or { State: FileState.New or FileState.Modified or FileState.Outdated } => Attention,
        { State: FileState.Missing } => SystemColors.GrayText,
        _ => _tree.ForeColor,
    };

    private string TipFor(FileStatus file)
    {
        var lines = new List<string> { file.VaultPath, BrowseState(file) };
        if (_vault != null)
        {
            var usedIn = _vault.UsedBy(file).Where(f => !VaultTree.IsDrawing(f.VaultPath)).Select(f => NameOf(f.VaultPath)).ToList();
            if (usedIn.Count > 0)
            {
                lines.Add("Used in: " + string.Join(", ", usedIn));
            }
            var drawings = _vault.Drawings(file).Select(f => NameOf(f.VaultPath)).ToList();
            if (drawings.Count > 0)
            {
                lines.Add("Drawings: " + string.Join(", ", drawings));
            }
        }
        return string.Join("\n", lines);
    }

    // Everything the lists show, to tell whether a refresh changed any of it.
    private static string Signature(VaultTree vault)
    {
        var text = new StringBuilder();
        void Folders(TreeFolder folder)
        {
            text.Append(folder.VaultPath).Append('\n');
            foreach (var child in folder.Folders)
            {
                Folders(child);
            }
        }
        Folders(vault.Root);
        foreach (var file in vault.Files)
        {
            text.Append(file.VaultPath).Append('|').Append(file.State).Append('|').Append(file.LocalVersion).Append('|').Append(file.RemoteVersion)
                .Append('|').Append(file.Lock?.User.Name).Append('|').Append(file.Lock?.Host).Append('|').Append(file.CheckedOutByMe);
            foreach (var used in vault.Uses(file) ?? Array.Empty<UsedStatus>())
            {
                text.Append('|').Append(used.FileId).Append('v').Append(used.Version);
            }
            text.Append('\n');
        }
        return text.ToString();
    }

    private static string NameOf(string vaultPath) => vaultPath.Substring(vaultPath.LastIndexOf('/') + 1);

    private static string FolderOf(string vaultPath) => vaultPath.LastIndexOf('/') is var slash and > 0 ? vaultPath.Substring(0, slash) : "the top folder";

    // --- layout -------------------------------------------------------------------------------

    private static TableLayoutPanel Stack(Control? fill, params Control[] controls)
    {
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, AutoScroll = true };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var control in controls)
        {
            table.RowStyles.Add(control == fill ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.AutoSize));
            table.Controls.Add(control);
        }
        return table;
    }

    private static TabPage Page(string title, Control content)
    {
        var page = new TabPage(title);
        page.Controls.Add(content);
        return page;
    }

    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var row = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true };
        row.Controls.AddRange(controls);
        return row;
    }

    // Buttons (at least Windows' standard 75x23) and rows are sized by their text, which already scales
    // with the display. GrowAndShrink keeps the pane's DPI scaling from leaving them enlarged, as
    // GrowOnly (the default) would.
    private static Button MakeButton(string text, EventHandler onClick)
    {
        var button = new Button { Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(75, 23) };
        button.Click += onClick;
        return button;
    }

    private static Label Caption(string text) => new Label { Text = text, AutoSize = true, Dock = DockStyle.Fill };

    private static Label Heading(string text) =>
        new Label { Text = text, AutoSize = true, Dock = DockStyle.Fill, Font = new Font(SystemFonts.MessageBoxFont, FontStyle.Bold), Padding = new Padding(0, 8, 0, 2) };
}

/// <summary>What to do when SolidWorks is about to show Save As (see <see cref="CvcPane.BeforeSaveAs"/>).</summary>
internal enum SaveAsChoice
{
    /// <summary>Let SolidWorks ask for a name, as usual.</summary>
    ShowDialog,

    /// <summary>Save to the document's own file, which is checked out to you now.</summary>
    SaveInPlace,

    /// <summary>Don't save.</summary>
    Cancel,
}
