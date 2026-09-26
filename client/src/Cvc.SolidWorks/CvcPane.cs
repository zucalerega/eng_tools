using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Cvc.Client;
using Timer = System.Windows.Forms.Timer;

namespace Cvc.SolidWorks;

/// <summary>
/// The CVC task pane: sign-in, the active document's status and actions, and the workspace
/// files that need attention. It runs on SolidWorks' main thread and awaits resume there, so
/// SolidWorks calls after an await are safe. Workspace isn't thread-safe, so the gate lets one
/// operation run at a time.
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
    private readonly Timer _poll = new Timer { Interval = 60_000 };
    private readonly Timer _debounce = new Timer { Interval = 400 };
    private readonly HashSet<string> _offered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private Workspace? _workspace;
    private Dictionary<string, FileStatus> _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
    private bool _busy;

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
    private readonly ListView _changes = new ListView
    {
        View = View.Details,
        FullRowSelect = true,
        HideSelection = false,
        Dock = DockStyle.Fill,
        MinimumSize = new Size(0, 140),
    };
    private readonly Control _workView;
    private readonly Label _message = new Label { Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(0, 6, 0, 0) };

    public CvcPane(SolidWorksHost sw)
    {
        _sw = sw;
        Font = SystemFonts.MessageBoxFont;
        Padding = new Padding(8);

        _signInButton = MakeButton("Sign in", (_, _) => Safely(SignInAsync));
        _setupView = Stack(
            null,
            Heading("CVC"),
            Caption("Sign in to the team's CVC server to check SolidWorks files in and out."),
            Caption("Server address"),
            _serverBox,
            Caption("Workspace folder (use the same one on every computer)"),
            _rootBox,
            Row(_signInButton));

        _checkOutButton = MakeButton("Check out", (_, _) => OnActiveDocument(CheckOutAsync));
        _checkInButton = MakeButton("Check in...", (_, _) => OnActiveDocument(path => CheckInAsync(new[] { path })));
        _undoButton = MakeButton("Undo check-out", (_, _) => OnActiveDocument(UndoAsync));
        _getButton = MakeButton("Get latest", (_, _) => OnActiveDocument(GetLatestAsync));
        _changes.Columns.Add("File", 190);
        _changes.Columns.Add("State", 100);
        _changes.Columns.Add("Checked out by", 130);
        _changes.DoubleClick += (_, _) => OpenSelected();
        _changes.ContextMenuStrip = ListMenu();
        _workView = Stack(
            _changes,
            _account,
            Row(MakeButton("Open folder", (_, _) => OpenFolder()), MakeButton("Sign out", (_, _) => SignOut())),
            Heading("Active document"),
            _activeName,
            _activeState,
            Row(_checkOutButton, _checkInButton, _undoButton, _getButton),
            Heading("Needs attention"),
            _changes,
            Row(
                MakeButton("Check in selected...", (_, _) => Safely(() => CheckInAsync(SelectedPaths()))),
                MakeButton("Get latest (everything)", (_, _) => Safely(GetEverythingAsync)),
                MakeButton("Refresh", (_, _) => RefreshSoon())));

        Controls.Add(_workView);
        Controls.Add(_setupView);
        Controls.Add(_message);
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
        if (Ask($"{name} isn't checked out to you. Check it out now and save?") != DialogResult.Yes)
        {
            return false;
        }
        if (!_gate.Wait(0))
        {
            Warn("CVC is busy. Try saving again in a moment.");
            return false;
        }
        try
        {
            // SolidWorks is waiting on this event, so check out synchronously (off this thread).
            Task.Run(() => workspace.CheckoutAsync(new[] { path })).GetAwaiter().GetResult();
            _sw.SetReadOnly(path, false);
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
            await CheckOutAsync(path);
        }
    }

    private Task CheckOutAsync(string path) => RunAsync("Checking out", async workspace =>
    {
        var outdated = StatusOf(path)?.State == FileState.Outdated;
        var reopen = outdated && _sw.IsOpen(path);
        if (reopen)
        {
            if (_sw.HasUnsavedChanges(path))
            {
                throw new WorkspaceException(
                    $"{Path.GetFileName(path)} has unsaved changes, and there's a newer version in the vault. "
                    + "Save your work under another name, close the file, then check out.");
            }
            _sw.Close(path); // it's about to be replaced with the latest version
        }
        await workspace.CheckoutAsync(new[] { path });
        if (reopen)
        {
            _sw.Open(path);
        }
        else
        {
            _sw.SetReadOnly(path, false);
        }
        return $"Checked out {Path.GetFileName(path)}.";
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
                "CVC",
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
        var changed = StatusOf(path)?.State is FileState.Modified or FileState.Conflict || _sw.HasUnsavedChanges(path);
        if (changed && Ask($"Undo the check-out of {name} and throw away your changes? A copy is kept in {workspace.Root}\\.cvc\\backup.") != DialogResult.Yes)
        {
            return null;
        }
        var reopen = changed && _sw.IsOpen(path);
        if (reopen)
        {
            _sw.Close(path);
        }
        var result = await workspace.UndoCheckoutAsync(new[] { path });
        if (reopen)
        {
            _sw.Open(path);
        }
        else
        {
            _sw.SetReadOnly(path, true);
        }
        return result.BackedUp.Count > 0 ? $"Undone. Your changes were saved to {result.BackedUp[0]}." : $"Undid the check-out of {name}.";
    });

    private Task GetLatestAsync(string path) => RunAsync("Getting the latest version", async workspace =>
    {
        // Open files can't be replaced: close the ones being updated, then reopen the active one.
        var involved = new List<string> { path };
        involved.AddRange(_sw.AllReferences(path));
        var stale = involved.Where(p => StatusOf(p)?.State == FileState.Outdated && _sw.IsOpen(p)).ToList();
        var unsaved = stale.Where(_sw.HasUnsavedChanges).ToList();
        if (unsaved.Count > 0)
        {
            throw new WorkspaceException("Save or close these first: " + string.Join(", ", unsaved.Select(Path.GetFileName)));
        }
        var reopen = stale.Count > 0 && _sw.IsOpen(path);
        if (stale.Count > 0)
        {
            _sw.Close(path);
            stale.Where(_sw.IsOpen).ToList().ForEach(_sw.Close);
        }
        var result = await workspace.GetLatestAsync(new[] { path });
        if (reopen)
        {
            _sw.Open(path);
        }
        return Summary(result);
    });

    private Task GetEverythingAsync() =>
        RunAsync("Getting the latest versions", async workspace => Summary(await workspace.GetLatestAsync()));

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
            var me = await workspace.WhoAmIAsync();
            var statuses = await workspace.StatusAsync();
            _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
            foreach (var status in statuses)
            {
                _statuses[VaultPaths.Key(status.VaultPath)] = status;
            }
            _account.Text = $"{me.Name} ({me.Email}) on {workspace.Host}\n{workspace.Server}\n{workspace.Root}";
            ShowChanges(statuses);
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
        _changes.Items.Clear();
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

    private List<string> SelectedPaths() =>
        _changes.SelectedItems.Cast<ListViewItem>().Select(i => ((FileStatus)i.Tag).LocalPath).ToList();

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
    }

    private (string Text, Color Color) Describe(string? path, FileStatus? status)
    {
        if (path == null || _workspace == null)
        {
            return ("", ForeColor);
        }
        if (!IsInWorkspace(path))
        {
            return ($"Not in the CVC workspace. Save it under {_workspace.Root} to version it.", Attention);
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
            });
        }
        _changes.EndUpdate();
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
        _changes.Enabled = !busy;
        ShowActiveDocument();
    }

    private void ShowMessage(string text, Color color)
    {
        _message.Text = text;
        _message.ForeColor = color;
    }

    private void Warn(string text) => MessageBox.Show(this, text, "CVC", MessageBoxButtons.OK, MessageBoxIcon.Warning);

    private DialogResult Ask(string question) => MessageBox.Show(this, question, "CVC", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

    private void OpenSelected()
    {
        foreach (var path in SelectedPaths().Where(File.Exists))
        {
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

    private ContextMenuStrip ListMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => OpenSelected());
        menu.Items.Add("Check out", null, (_, _) => Safely(() => RunAsync("Checking out", async workspace =>
        {
            var paths = SelectedPaths();
            await workspace.CheckoutAsync(paths);
            paths.ForEach(p => _sw.SetReadOnly(p, false));
            return $"Checked out {Count(paths.Count, "file")}.";
        })));
        menu.Items.Add("Check in...", null, (_, _) => Safely(() => CheckInAsync(SelectedPaths())));
        menu.Items.Add("Get latest", null, (_, _) => Safely(() => RunAsync("Getting the latest versions", async workspace =>
            Summary(await workspace.GetLatestAsync(SelectedPaths())))));
        return menu;
    }

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

    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var row = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true };
        row.Controls.AddRange(controls);
        return row;
    }

    private static Button MakeButton(string text, EventHandler onClick)
    {
        var button = new Button { Text = text, AutoSize = true };
        button.Click += onClick;
        return button;
    }

    private static Label Caption(string text) => new Label { Text = text, AutoSize = true, Dock = DockStyle.Fill };

    private static Label Heading(string text) =>
        new Label { Text = text, AutoSize = true, Dock = DockStyle.Fill, Font = new Font(SystemFonts.MessageBoxFont, FontStyle.Bold), Padding = new Padding(0, 8, 0, 2) };
}
