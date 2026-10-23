using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Vault.Client;
using Timer = System.Windows.Forms.Timer;

namespace Vault.SolidWorks;

/// <summary>
/// The Vault task pane: sign-in, the active document's status and what you can do with it, the files here that need
/// attention, and the whole vault to browse. It runs on SolidWorks' main thread and awaits resume there, so SolidWorks
/// calls after an await are safe. Workspace isn't thread-safe, so the gate lets one operation run at a time.
/// </summary>
internal sealed partial class VaultPane : UserControl
{
    private readonly SolidWorksHost _sw;
    private readonly AddinSettings _settings = AddinSettings.Load();
    private readonly TokenStore _tokens = new TokenStore();
    private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
    // Every workspace's requests say when someone is working in SolidWorks, for Admin > People's time in SolidWorks.
    private readonly ActivityHandler _sayWhenWorking = new ActivityHandler(SolidWorksActivity.InUse);
    private readonly Timer _poll = new Timer { Interval = 20_000 };
    private readonly Timer _debounce = new Timer { Interval = 400 };
    // SolidWorks shows the pane in its task pane's window, but doesn't always size it to that window: on some PCs it stays
    // as small as it was made, with everything crammed into it. So the pane follows that window's size itself.
    private readonly Timer _fit = new Timer { Interval = 250 };
    private readonly ToolTip _tips = new ToolTip { AutoPopDelay = 20_000 };
    private readonly HashSet<string> _offered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private Workspace? _workspace;
    private Account? _me;
    private VaultTree? _vault;
    private Dictionary<string, FileStatus> _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
    private string _shown = ""; // what the lists show, to redraw them only when it changes
    private bool _busy;
    private bool _doubleClicking;
    private Download? _newerAddIn; // the server's installer, when it's newer than this add-in
    private DateTime _checkedForUpdate = DateTime.MinValue;

    // The header, over both views: Vault's mark, and once you're signed in, an update when there is one, refresh, and
    // your account.
    private readonly FlatButton _newVersionButton;
    private readonly FlatButton _refreshButton;
    private readonly FlatButton _accountButton;
    private readonly ContextMenuStrip _accountMenu = new ContextMenuStrip { Renderer = Theme.MenuRenderer };
    private readonly ToolStripLabel _accountName = new ToolStripLabel { Font = Theme.Bold };
    private readonly ToolStripLabel _accountEmail = new ToolStripLabel { ForeColor = Theme.Muted };
    private readonly ToolStripLabel _accountServer = new ToolStripLabel { ForeColor = Theme.Muted };
    private readonly ToolStripLabel _accountFolder = new ToolStripLabel { ForeColor = Theme.Muted };
    private readonly ToolStripLabel _accountVersion = new ToolStripLabel
    {
        ForeColor = Theme.Muted,
        Text = "Vault add-in " + Release(typeof(VaultPane).Assembly.GetName().Version),
    };
    private readonly ActivityBar _activity = new ActivityBar();

    // Signing in.
    private readonly TextBox _serverBox = Field();
    private readonly TextBox _rootBox = Field();
    private readonly FlatButton _signInButton;
    private readonly Control _setupView;

    // The active document's card.
    private readonly Card _documentCard = new Card();
    private readonly Label _documentName = Words("", Theme.Heading);
    private readonly Pill _documentStatus = new Pill();
    private readonly Label _documentDetail = Words("", color: Theme.Muted);
    private readonly FlowLayoutPanel _documentActions = Row();
    private readonly FlatButton _checkOutButton;
    private readonly FlatButton _checkInButton;
    private readonly FlatButton _undoButton;
    private readonly FlatButton _getButton;
    private readonly FlatButton _takeOverButton;
    private readonly FlatButton _drawingButton;
    private readonly FlatButton _caliperButton;
    private readonly FlatButton _keepMineButton;
    private readonly FlatButton _useVaultButton;

    // The files that need attention, or the whole vault, by the tab that's chosen.
    private readonly ImageList _images;
    private readonly RadioButton _changesTab = Tab("Needs attention");
    private readonly RadioButton _browseTab = Tab("Browse");
    private readonly ThemedList _changes = new ThemedList();
    private readonly Label _changesEmpty = new Label
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Theme.Muted,
        BackColor = Theme.Surface,
        UseCompatibleTextRendering = false,
    };
    private readonly ThemedTree _tree = new ThemedTree();
    private readonly Card _lists = new Card { AutoSize = false, Padding = new Padding(4), MinimumSize = new Size(0, 180) };
    private readonly FlatButton _updateButton;
    private readonly FlatButton _everythingButton;
    private readonly FlatButton _freeUpButton;
    private readonly Control _workView;

    // The line at the bottom: what Vault is doing, or how the last thing went.
    private readonly Label _message = Words("");
    private readonly Control _statusBar;

    /// <summary>Brings the Vault tab to the front of SolidWorks' task pane; the session that made the tab sets it.</summary>
    public Action? ShowTab { get; set; }

    public VaultPane(SolidWorksHost sw)
    {
        _sw = sw;
        SuspendLayout();
        Font = Theme.Base;
        BackColor = Theme.Background;
        ForeColor = Theme.Text;

        _newVersionButton = new FlatButton("Update") { Primary = true, Visible = false, MinimumSize = new Size(0, 26), Margin = new Padding(2, 0, 4, 0) };
        _newVersionButton.Click += (_, _) => Safely(UpdateAddInAsync);
        _refreshButton = IconButton("\uE72C", "Refresh", (_, _) => RefreshSoon());
        _tips.SetToolTip(_refreshButton, "Refresh now. Vault also refreshes every 20 seconds, and after everything you do.");
        _accountButton = new FlatButton("Account ▾") { Quiet = true, Margin = new Padding(2, 0, 0, 0) };
        _accountButton.Click += (_, _) =>
            _accountMenu.Show(_accountButton, new Point(_accountButton.Width, _accountButton.Height), ToolStripDropDownDirection.BelowLeft);
        _accountMenu.Items.AddRange(new ToolStripItem[]
        {
            _accountName,
            _accountEmail,
            new ToolStripSeparator(),
            _accountServer,
            _accountFolder,
            _accountVersion,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Open the web app", null, (_, _) => Guarded(OpenWebApp)),
            new ToolStripMenuItem("Open the workspace folder", null, (_, _) => Guarded(OpenFolder)),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Sign out", null, (_, _) => Guarded(SignOut)),
        });

        _signInButton = MakeButton("Sign in", (_, _) => Safely(SignInAsync), "Sign in in your browser, then come back here.");
        _signInButton.Primary = true;
        _setupView = SignInView();

        _checkOutButton = MakeButton(
            "Check out",
            (_, _) => OnActiveDocument(path => CheckOutAsync(new[] { path })),
            "Check it out to change it: nobody else can check it in meanwhile. If yours is out of date, the latest version comes first.");
        _checkInButton = MakeButton(
            "Check in...",
            (_, _) => OnActiveDocument(path => CheckInAsync(new[] { path })),
            "Save your changes as a new version for everyone, with a comment. New parts, and parts you changed, that it uses go in too.");
        _undoButton = MakeButton(
            "Undo check-out",
            (_, _) => OnActiveDocument(UndoAsync),
            "Give the file back as it is in the vault. Your changes are thrown away, with a copy kept in the workspace's .vault\\backup folder.");
        _getButton = MakeButton(
            "Get latest",
            (_, _) => OnActiveDocument(GetLatestAsync),
            "Download the newest version of this file and of the parts it uses. Open files update in place.");
        _takeOverButton = MakeButton(
            "Take over...",
            (_, _) => OnActiveDocument(TakeOverAsync),
            "Move the check-out to this computer, to change the file here. Vault asks first.");
        _drawingButton = MakeButton(
            "Open drawing",
            (sender, _) => OnActiveDocument(path => OpenDrawingAsync(path, (Control)sender!)),
            "Open this part's or assembly's drawing.");
        _caliperButton = MakeButton(
            "Make 3D view",
            (_, _) => OnActiveDocument(MakeModelsHereAsync),
            "Make the 3D views that Caliper shows in the web app, of this file and of what it uses, where they're missing. Check-ins make them too.");
        _keepMineButton = MakeButton(
            "Keep mine...",
            (_, _) => OnActiveDocument(path => KeepMineAsync(new[] { path })),
            "Keep your copy: it's checked out to you as it is, and checking it in makes it the next version. The vault's stays in the history.");
        _useVaultButton = MakeButton(
            "Use the vault's version...",
            (_, _) => OnActiveDocument(path => UseVaultVersionAsync(new[] { path })),
            "Replace your copy with the vault's latest version. Yours is kept in the workspace's .vault\\backup folder.");
        _documentActions.Controls.AddRange(new Control[]
        {
            _checkInButton, _checkOutButton, _getButton, _undoButton, _takeOverButton, _drawingButton, _caliperButton, _keepMineButton, _useVaultButton,
        });
        _documentActions.Margin = new Padding(0, 6, 0, 0);
        _documentCard.SizeChanged += (_, _) =>
            _documentStatus.MaximumSize = new Size(Math.Max(1, _documentCard.ClientSize.Width - _documentCard.Padding.Horizontal), 0);

        _images = Theme.StatusImages(LogicalToDeviceUnits(20));
        _changes.SmallImageList = _images;
        _changes.Columns.Add("Name");
        _changes.Columns.Add("Status");
        _changes.Columns.Add("Folder");
        _changes.ClientSizeChanged += (_, _) => FitColumns();
        _changes.DoubleClick += (_, _) => Safely(() => OpenAsync(SelectedPaths()));
        _changes.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true;
                Safely(() => OpenAsync(SelectedPaths()));
            }
        };
        _changes.ContextMenuStrip = ItemMenu();
        _tree.ImageList = _images;
        _tree.ImageKey = _tree.SelectedImageKey = Theme.NoImage;
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
        _changesTab.CheckedChanged += (_, _) => ShowView();
        _changesTab.Checked = true;
        _updateButton = MakeButton(
            "Update downloaded files",
            (_, _) => Safely(UpdateMineAsync),
            "Get the newest version of every vault file on this computer, and any new parts they've started to use. Nothing else is downloaded.");
        _everythingButton = MakeButton(
            "Download everything...",
            (_, _) => Safely(DownloadEverythingAsync),
            "Download every file in the vault you have access to. Vault says how many files that is, and how much space, and asks first.");
        _freeUpButton = MakeButton(
            "Free up space...",
            (_, _) => Safely(() => FreeUpSpaceAsync(null)),
            "Remove the copies on this computer of files you haven't changed and don't have checked out. They stay in the vault, "
                + "and download again when you open them. Vault says how much that frees, and asks first.");
        _workView = WorkView();
        _statusBar = StatusBar();

        // Docked last to first: the status bar, the header, and the line under it, then the view that fills the rest.
        Controls.Add(_workView);
        Controls.Add(_setupView);
        Controls.Add(_activity);
        Controls.Add(Header());
        Controls.Add(_statusBar);
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
            ShowMessage(Reason(e), Tone.Problem);
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
        var answer = MessageDialog.Show(
            this,
            $"{name} isn't checked out to you.\n\nYes: check it out and save it.\nNo: save your changes under another name.",
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
    /// From the link listener's thread: open a vault:// link from the web app. It's done on SolidWorks'
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
        // A big assembly can take a while to download; the file still opens when it's done, and anything that goes wrong
        // is still shown here.
        if (done.Task.Wait(TimeSpan.FromMinutes(10)))
        {
            return done.Task.Result;
        }
        Log.Info("Still following the link after 10 minutes: vault-open.exe stops waiting for it");
        return "";
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
        if (request.Action == LinkAction.Connect)
        {
            return await ConnectAsync(request.Server);
        }
        var workspace = _workspace;
        if (workspace == null)
        {
            ShowTab?.Invoke();
            // Any web page can make a link: one for a server SolidWorks isn't set up for doesn't get to say where you sign in.
            if (OpenLink.ConnectQuestion(request.Server, _settings.WorkspaceRoot, LastServer) != null)
            {
                return $"SolidWorks isn't connected to the vault at {OpenLink.Address(request.Server)}. To connect it, click Connect "
                    + "SolidWorks on that vault's SolidWorks page.";
            }
            _serverBox.Text = request.Server.AbsoluteUri; // ready to sign in to that vault
            return "Sign in to Vault in SolidWorks first: open the Vault tab in the task pane.";
        }
        if (!OpenLink.SameServer(workspace.Server, request.Server))
        {
            return $"That link is for the vault at {OpenLink.Address(request.Server)}, but SolidWorks is connected to the one at "
                + $"{OpenLink.Address(workspace.Server)}: open the file from that one in your browser. To switch vaults, sign out in "
                + "the Vault tab, type another folder there (each vault needs its own), then click Connect SolidWorks on the other "
                + "vault's SolidWorks page.";
        }
        string path;
        string? model;
        try
        {
            path = workspace.ToLocalPath(request.VaultPath);
            model = request.Model == null ? null : workspace.ToLocalPath(request.Model);
        }
        catch (VaultPathException e)
        {
            return e.Message; // in the workspace's own folder, say
        }
        SolidWorksHost.BringToFront();
        // The tab says what Vault is doing (a big assembly takes a while to come down), and what went wrong, if anything:
        // another of the task pane's tabs could be in front.
        ShowTab?.Invoke();
        await (request.Action == LinkAction.New ? NewFileAsync(path, model) : OpenLatestAsync(path));
        SolidWorksHost.BringToFront();
        return ""; // what went wrong, if anything, is shown here in SolidWorks
    }

    /// <summary>
    /// Open a file for the web app's Open in SolidWorks: its latest version first, with the parts it uses (open copies
    /// update in place). Why it couldn't be opened, if it couldn't, is shown here, as for anything else Vault does.
    /// </summary>
    private Task OpenLatestAsync(string path) => RunAsync($"Opening {Path.GetFileName(path)}", async workspace =>
    {
        var got = await GetLatestHereAsync(workspace, path, quiet: true);
        if (_sw.Open(path) is { } problem)
        {
            throw new WorkspaceException(problem);
        }
        return $"Opened {Path.GetFileName(path)}." + (got.Length > 0 ? " " + got : "");
    });

    /// <summary>
    /// For the web app's Connect SolidWorks: sign in to that vault, with the workspace folder shown (C:\VLT
    /// unless you chose another). Already signed in to it, there's nothing to do; signed in to another
    /// vault, it says so, since switching is yours to choose (sign out, then connect again). A vault
    /// SolidWorks isn't set up for (or any, the first time) is asked about first, by its address: any web
    /// page can make the link, and a server that isn't the team's would get your sign-in.
    /// </summary>
    private async Task<string> ConnectAsync(Uri server)
    {
        SolidWorksHost.BringToFront();
        ShowTab?.Invoke();
        if (_workspace is { } workspace)
        {
            if (OpenLink.SameServer(workspace.Server, server))
            {
                ShowMessage("SolidWorks is connected to this vault.", Tone.Good);
                return "";
            }
            return $"SolidWorks is connected to the vault at {OpenLink.Address(workspace.Server)}. To switch, sign out in the Vault tab, "
                + "then connect again.";
        }
        if (OpenLink.ConnectQuestion(server, _settings.WorkspaceRoot, LastServer) is { } question
            && Ask(question, defaultNo: true) != DialogResult.Yes)
        {
            Log.Info($"Didn't connect to {OpenLink.Address(server)}, which SolidWorks isn't set up for: it wasn't confirmed");
            ShowMessage("Not connected: SolidWorks connects to a new vault only when you say it's your team's.", Tone.Neutral);
            return "";
        }
        _serverBox.Text = server.AbsoluteUri;
        try
        {
            await SignInAsync();
            return "";
        }
        catch (Exception e) when (IsExpected(e) || e is UriFormatException)
        {
            Log.Error($"Connecting to {server} failed", e);
            ShowMessage(Reason(e), Tone.Problem);
            return Reason(e);
        }
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
            _fit.Dispose();
            _workspace?.Dispose();
            _sayWhenWorking.Dispose();
            _gate.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>
    /// Fill the window SolidWorks shows the pane in (its parent, since DisplayWindowFromHandlex64), now and whenever that
    /// window changes size.
    /// </summary>
    public void FillHostWindow()
    {
        _fit.Tick += (_, _) => FitToHostWindow();
        FitToHostWindow();
        _fit.Start();
    }

    private void FitToHostWindow()
    {
        try
        {
            var host = GetParent(Handle);
            if (host == IntPtr.Zero || !GetClientRect(host, out var area))
            {
                return;
            }
            var fill = new Rectangle(0, 0, area.Right - area.Left, area.Bottom - area.Top);
            if (fill.Width > 0 && fill.Height > 0 && Bounds != fill)
            {
                Bounds = fill;
            }
        }
        catch (Exception e)
        {
            // Never into SolidWorks, and not four times a second: stop, log it, and leave the size to SolidWorks.
            _fit.Stop();
            Log.Error("Fitting the Vault tab to the task pane failed", e);
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr window, out NativeRect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    // --- actions ------------------------------------------------------------------------------

    private async Task SignInAsync()
    {
        var server = ParseServer(_serverBox.Text);
        var root = Path.GetFullPath(_rootBox.Text.Trim());
        var existing = Workspace.FindRoot(root);
        if (existing != null && !OpenLink.SameServer(Workspace.ServerOf(existing), server))
        {
            throw new WorkspaceException($"{existing} is a workspace for {Workspace.ServerOf(existing)}. Choose another folder.");
        }
        _signInButton.Enabled = false;
        try
        {
            ShowMessage("Finish signing in in your browser...", Tone.Info);
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
            ShowMessage($"Signed in as {issued.User.Name}.", Tone.Good);
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
        ShowMessage("Signed out.", Tone.Neutral);
    }

    private async Task OfferCheckoutAsync(string path)
    {
        var status = StatusOf(path);
        if (status?.FileId == null || status.CheckedOutByMe)
        {
            return;
        }
        var name = Path.GetFileName(path);
        if (status.Lock is { } yours && yours.User.Id == _me?.Id)
        {
            await TakeOverAsync(path); // checked out to you in the web app, or on another computer: move it here
        }
        else if (status.Lock is { } other)
        {
            Warn($"{name} is checked out by {other.User.Name} {On(other.Host)}, so you won't be able to save changes to it.");
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
        var question = other.User.Id != _me?.Id
            ? $"Take over {other.User.Name}'s check-out of {name}? It will be checked out to you here, and their check-out ends. "
                + $"Their changes stay on {other.Host}, and Vault tells them what happened if they try to check in."
            : other.Host == Workspace.WebHost
                ? $"{name} is checked out to you in the web app. Move the check-out to this computer, to change it here?"
                : $"Move your check-out of {name} from {other.Host} to this computer? Changes you made on {other.Host} stay there.";
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

    /// <summary>
    /// Keep your copies of files in conflict, after asking: they're checked out to you as they are, and checking them in
    /// makes them the next versions, on top of the vault's, which stay in the history (Workspace.KeepMineAsync).
    /// </summary>
    private async Task KeepMineAsync(IReadOnlyList<string> paths)
    {
        var conflicts = InConflict(paths);
        if (conflicts.Count == 0)
        {
            return;
        }
        var question = conflicts.Count == 1
            ? $"Keep your copy of {Path.GetFileName(conflicts[0].LocalPath)}? It's checked out to you as it is, and checking it in makes "
                + $"it version {conflicts[0].RemoteVersion + 1}. Version {conflicts[0].RemoteVersion}, the vault's now, stays in its history."
            : $"Keep your copies of {Count(conflicts.Count, "file")}? They're checked out to you as they are, and checking them in makes "
                + "them the next versions. The vault's versions stay in their history.";
        if (Ask(question) != DialogResult.Yes)
        {
            return;
        }
        var local = conflicts.Select(s => s.LocalPath).ToList();
        await RunAsync("Keeping your copy", async workspace =>
        {
            await workspace.KeepMineAsync(local);
            foreach (var path in local)
            {
                _sw.SetReadOnly(path, false);
            }
            return local.Count == 1
                ? $"Kept your copy of {Path.GetFileName(local[0])}: it's checked out to you, to check in when it's ready."
                : $"Kept your copies of {Count(local.Count, "file")}: they're checked out to you, to check in when they're ready.";
        });
    }

    /// <summary>
    /// Replace your copies of files in conflict with the vault's latest versions, after asking. Yours are backed up first
    /// (Workspace.UseVaultVersionAsync); unsaved changes in SolidWorks are lost, and the question says so.
    /// </summary>
    private async Task UseVaultVersionAsync(IReadOnlyList<string> paths)
    {
        var conflicts = InConflict(paths);
        if (conflicts.Count == 0 || _workspace == null)
        {
            return;
        }
        var local = conflicts.Select(s => s.LocalPath).ToList();
        var backup = $"{_workspace.Root}\\.vault\\backup";
        var unsaved = local.Any(_sw.HasUnsavedChanges) ? " Changes you haven't saved in SolidWorks are lost." : "";
        var question = conflicts.Count == 1
            ? $"Replace your copy of {Path.GetFileName(local[0])} with version {conflicts[0].RemoteVersion} from the vault? Yours is kept in {backup}.{unsaved}"
            : $"Replace your copies of {Count(local.Count, "file")} with the vault's versions? Yours are kept in {backup}.{unsaved}";
        if (Ask(question) != DialogResult.Yes)
        {
            return;
        }
        await RunAsync("Getting the vault's version", async workspace =>
        {
            var result = await ReplacingAsync(local, () => workspace.UseVaultVersionAsync(local), discardChanges: true);
            var kept = result.BackedUp.Count == 1 ? $" Yours is in {result.BackedUp[0]}." : result.BackedUp.Count > 1 ? $" Yours are in {backup}." : "";
            return Summary(result) + kept;
        });
    }

    private List<FileStatus> InConflict(IEnumerable<string> paths) =>
        paths.Select(StatusOf).OfType<FileStatus>().Where(s => s.State == FileState.Conflict).ToList();

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
            var answer = MessageDialog.Show(
                this,
                "Save changes before checking in?\n\n" + string.Join("\n", unsaved.Select(Path.GetFileName)),
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
            var checkedIn = $"Checked in {Count(result.Files.Count, "file")}.";
            // The 3D views of what's checked in, for Caliper in the web app: SolidWorks has it all open now.
            foreach (var path in paths)
            {
                checkedIn = $"{checkedIn} {await MakeModelsAsync(workspace, path)}".TrimEnd();
            }
            return checkedIn;
        });
    }

    private Task UndoAsync(string path) => RunAsync("Undoing the check-out", async workspace =>
    {
        var name = Path.GetFileName(path);
        // What's on disk now: a save a moment ago may not be in the last refresh.
        var replaced = (await CurrentStatusAsync(workspace, new[] { path })).Any(s => s.State is FileState.Modified or FileState.Conflict or FileState.Outdated);
        var changed = replaced || _sw.HasUnsavedChanges(path);
        if (changed && Ask($"Undo the check-out of {name} and throw away your changes? A copy is kept in {workspace.Root}\\.vault\\backup.") != DialogResult.Yes)
        {
            return null;
        }
        // You've agreed to lose unsaved changes too, so the document is reloaded regardless.
        var result = await ReplacingAsync(changed ? new[] { path } : Array.Empty<string>(), () => workspace.UndoCheckoutAsync(new[] { path }), discardChanges: true);
        _sw.SetReadOnly(path, true);
        return result.BackedUp.Count > 0 ? $"Undone. Your changes were saved to {result.BackedUp[0]}." : $"Undid the check-out of {name}.";
    });

    private Task GetLatestAsync(string path) =>
        RunAsync("Getting the latest version", async workspace => await GetLatestHereAsync(workspace, path));

    // The file and the parts it uses are updated in place, open or not. Quiet: nothing to say if nothing came down. A file
    // that isn't here after it is a WorkspaceException saying why.
    private async Task<string> GetLatestHereAsync(Workspace workspace, string path, bool quiet = false)
    {
        var involved = new List<string> { path };
        involved.AddRange(_sw.AllReferences(path));
        var stale = (await CurrentStatusAsync(workspace, involved)).Where(s => s.State == FileState.Outdated).Select(s => s.LocalPath).ToList();
        RefuseUnsaved(stale, "get the latest version");
        IReadOnlyList<string> notInVault = Array.Empty<string>();
        var result = await ReplacingAsync(stale, async () =>
        {
            var got = await workspace.GetLatestAsync(new[] { path });
            var (used, missing) = await workspace.GetUsedFilesAsync(path, _sw.KeptReferences, latest: true);
            got.Add(used);
            notInVault = missing;
            return got;
        });
        if (workspace.WhyNotHere(path, result) is { } notHere)
        {
            throw new WorkspaceException(notHere);
        }
        var nothing = result.Downloaded.Count + result.Removed.Count + result.Skipped.Count + result.Failures.Count + notInVault.Count == 0;
        return quiet && nothing ? "" : Summary(result) + NotInVaultNote(notInVault);
    }

    /// <summary>
    /// Insert a part or assembly from the vault into the active assembly, in one step: its latest version, and the
    /// parts it uses, come down first if they aren't here (as Get latest gets them), then SolidWorks adds it beside the
    /// assembly, selected, to drag into place and mate. Changing the assembly then offers its check-out, as any change does.
    /// </summary>
    private Task InsertAsync(string path)
    {
        if (ActiveAssembly() is not { } assembly)
        {
            Warn("Open the assembly to insert it into, so it's the active document, then try again.");
            return Task.CompletedTask;
        }
        var name = Path.GetFileName(path);
        var into = Path.GetFileName(assembly);
        // Someone else's assembly can take the part, but not be saved with it: say so first, and only once.
        if (StatusOf(assembly) is { Lock: { } other, CheckedOutByMe: false } && other.User.Id != _me?.Id)
        {
            if (Ask($"{into} is checked out by {other.User.Name} {On(other.Host)}, so you won't be able to save it with {name} in it. Insert it anyway?")
                != DialogResult.Yes)
            {
                return Task.CompletedTask;
            }
            _offered.Add(assembly);
        }
        return RunAsync($"Inserting {name}", async workspace =>
        {
            var got = await GetLatestHereAsync(workspace, path, quiet: true);
            if (_sw.InsertComponent(assembly, path) is { } problem)
            {
                throw new WorkspaceException(problem);
            }
            return $"Inserted {name} into {into}: drag it into place and mate it." + (got.Length > 0 ? " " + got : "");
        });
    }

    // Every few hours, after a refresh: whether the server offers a newer add-in than this one. Quiet if it can't say.
    private async Task CheckForUpdateAsync(Workspace workspace)
    {
        if (DateTime.UtcNow - _checkedForUpdate < TimeSpan.FromHours(4))
        {
            return;
        }
        _checkedForUpdate = DateTime.UtcNow;
        try
        {
            _newerAddIn = AddInUpdate.Newer(await workspace.Api.DownloadsAsync(), typeof(VaultPane).Assembly.GetName().Version);
        }
        catch (Exception e) when (IsExpected(e))
        {
            Log.Info("Couldn't check for a newer add-in: " + e.Message);
        }
        _newVersionButton.Visible = _newerAddIn != null;
        if (_newerAddIn != null)
        {
            _tips.SetToolTip(_newVersionButton, $"Vault {_newerAddIn.Version} is ready. Click to update: setup finishes when you close SolidWorks.");
        }
    }

    /// <summary>
    /// Update the add-in to the newer one the server offers: download its installer, check it (AddInUpdate.DownloadAsync:
    /// its SHA-256, its signature by the key Vault's releases are signed with, and its version), and start it. Windows
    /// asks to let it make changes; setup then waits for SolidWorks to close, since SolidWorks has this add-in loaded, and
    /// installs the update. Sign-in, settings, and the workspace stay. One that doesn't check out isn't started: the tab
    /// says why, and so does the log.
    /// </summary>
    private async Task UpdateAddInAsync()
    {
        if (_newerAddIn is not { } installer
            || Ask($"Update Vault to version {installer.Version}? Vault downloads it and checks it's signed as Vault's releases are, then "
                + "Windows asks to let setup make changes. Setup finishes the update when you close SolidWorks, so save your work first. "
                + "Your sign-in, settings, and workspace stay.")
                != DialogResult.Yes)
        {
            return;
        }
        await RunAsync($"Downloading Vault {installer.Version}", async workspace =>
        {
            string setup;
            try
            {
                setup = await AddInUpdate.DownloadAsync(workspace.Api, installer, Path.Combine(Path.GetTempPath(), "Vault"));
            }
            catch (WorkspaceException)
            {
                _checkedForUpdate = DateTime.MinValue; // what's offered may have changed since: look again at the next refresh
                throw;
            }
            try
            {
                Process.Start(new ProcessStartInfo(setup, "/update") { UseShellExecute = true, Verb = "runas" })?.Dispose();
            }
            catch (Win32Exception e) when (e.NativeErrorCode == 1223) // ERROR_CANCELLED: Windows' question was answered No
            {
                return "The update needs Windows' permission to install. Click Update again when you're ready.";
            }
            return $"Vault {installer.Version} is ready to install: close SolidWorks, and setup finishes the update.";
        });
    }

    // "0.5.0": a version as releases are numbered.
    private static string Release(Version? version) => version == null ? "" : $"{version.Major}.{version.Minor}.{Math.Max(0, version.Build)}";

    // The active document, if it's an assembly: what Insert puts files in.
    private string? ActiveAssembly() => _sw.ActiveDocumentPath is { } path && SolidWorksHost.IsAssembly(path) ? path : null;

    /// <summary>
    /// Before opening a SolidWorks file that's here: the files it uses that aren't, at every level (a sub-assembly that's
    /// here can still be missing its parts), by the paths SolidWorks keeps in them (<see cref="Workspace.GetUsedFilesAsync"/>).
    /// It waits for whatever Vault is doing, a refresh included. Nothing to say if they're all here and in the vault.
    /// </summary>
    private Task GetWhatItUsesAsync(string path) =>
        RunAsync("Getting the files it uses", async workspace =>
        {
            var (result, notInVault) = await workspace.GetUsedFilesAsync(path, _sw.KeptReferences, latest: false);
            return result.Downloaded.Count + result.Failures.Count + notInVault.Count == 0 ? "" : Summary(result) + NotInVaultNote(notInVault);
        });

    // What the files got use that's in neither the vault nor anywhere here (like files left behind on Kenesto): the
    // first few by name, and all of them in the log.
    private static string NotInVaultNote(IReadOnlyList<string> notInVault)
    {
        if (notInVault.Count == 0)
        {
            return "";
        }
        Log.Info("Used, but not in the vault or on this computer: " + string.Join("; ", notInVault));
        // By the names people know them by: a STEP file placed with 3D Interconnect by its own, not SolidWorks' copy's.
        var names = notInVault.Select(Workspace.UsedFileName).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var shown = string.Join(", ", names.Take(3)) + (names.Count > 3 ? $", and {names.Count - 3} more" : "");
        return $" {Count(names.Count, "file")} it uses {(names.Count == 1 ? "isn't" : "aren't")} in the vault: {shown}. "
            + $"Where they were is in {Log.FilePath}.";
    }

    /// <summary>
    /// The file in the workspace a path kept in a SolidWorks file from elsewhere means (see
    /// <see cref="Workspace.LocalFileFor"/>), for SolidWorks when it can't find one; null if none is here.
    /// </summary>
    public string? LocalFileFor(string keptPath) =>
        _workspace?.LocalFileFor(keptPath, _statuses.Values.Where(s => s.FileId != null).Select(s => s.VaultPath));

    // Where a check-out is: "on LAB-PC", or "in the web app".
    private static string On(string host) => host == Workspace.WebHost ? "in the web app" : $"on {host}";

    // The files here, at their latest versions (with any new parts they use): nothing else comes down.
    private Task UpdateMineAsync() =>
        RunAsync("Updating downloaded files", async workspace =>
        {
            var result = await GetUpdatingOpenAsync(workspace, () => workspace.UpdateAsync());
            var quiet = result.Downloaded.Count + result.Removed.Count + result.Skipped.Count + result.Failures.Count == 0;
            return quiet ? "Everything here is up to date." : Summary(result);
        });

    // Every file you have access to: only after saying how much that is, and how much room there is, and you saying
    // yes (No is the default, so Enter doesn't start it).
    private Task DownloadEverythingAsync() =>
        RunAsync("Getting everything", async workspace =>
        {
            ShowMessage("Checking how much that is...", Tone.Info);
            var size = await workspace.SizeOfGetAsync();
            if (size.Files == 0)
            {
                return "You have the latest of everything already.";
            }
            var updates = size.UpdatedFiles > 0 ? $", and newer versions of {Count(size.UpdatedFiles, "file")} that are" : "";
            var question = $"Download every file in the vault you have access to? That's {Count(size.NewFiles, "file")} not on "
                + $"this computer yet{updates}: {FormatSize(size.Bytes)}.{RoomLeft(workspace.Root)}\n\nTo get just what you "
                + "work on, open it (the parts it uses come along), or right-click its folder in Browse and choose Get latest.";
            if (Ask(question, defaultNo: true) != DialogResult.Yes)
            {
                return null;
            }
            ShowMessage($"Downloading {Count(size.Files, "file")} ({FormatSize(size.Bytes)})...", Tone.Info);
            return Summary(await GetUpdatingOpenAsync(workspace, () => workspace.GetLatestAsync()));
        });

    /// <summary>
    /// Free up space: remove the copies here of files under these paths (everything, with none) that are as they came
    /// from the vault and not checked out to you, after saying how much that frees. Files open in SolidWorks, and the
    /// files they use, stay. The rest stay in the vault, and come back when they're opened or got.
    /// </summary>
    private Task FreeUpSpaceAsync(IReadOnlyList<string>? paths) =>
        RunAsync("Freeing up space", async workspace =>
        {
            var inUse = InUse();
            var (files, bytes) = await workspace.SizeOfFreeUpAsync(paths, inUse.Contains);
            if (files == 0)
            {
                return "Nothing to free up: what's here is changed, checked out to you, or open in SolidWorks.";
            }
            var where = paths is { Count: 1 } && Directory.Exists(paths[0]) ? $" in {Path.GetFileName(paths[0].TrimEnd('\\'))}" : "";
            var question = $"Remove the copies of {Count(files, "file")}{where} from this computer, freeing {FormatSize(bytes)}? "
                + "They stay in the vault, and download again when you open them, which needs a connection to the vault: keep "
                + "what you'll need offline. Files you've changed, files checked out to you, and files open in SolidWorks stay.";
            if (Ask(question, defaultNo: true) != DialogResult.Yes)
            {
                return null;
            }
            var result = await workspace.FreeUpAsync(paths, inUse.Contains);
            if (result.Failures.Count > 0)
            {
                Log.Info("Couldn't free up: " + string.Join("; ", result.Failures));
            }
            var stayed = result.Failures.Count == 0 ? "" : $" {Count(result.Failures.Count, "file")} in use stayed.";
            return $"Freed {FormatSize(result.Bytes)}: {Count(result.Removed.Count, "file")} in the vault only, until you open them again.{stayed}";
        });

    // What SolidWorks has open, and what that uses: never removed from under it.
    private HashSet<string> InUse()
    {
        var inUse = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in _sw.OpenDocuments().Select(SolidWorksHost.PathOf).OfType<string>())
        {
            if (inUse.Add(path))
            {
                inUse.UnionWith(_sw.AllReferences(path));
            }
        }
        return inUse;
    }

    // Get latest on what's selected: files with what they use. A folder's files that aren't here yet come down after
    // saying how much they are.
    private Task GetSelectedAsync(IReadOnlyList<string> paths, bool folder) =>
        RunAsync("Getting the latest versions", async workspace =>
        {
            if (folder && await workspace.SizeOfGetAsync(paths) is { NewFiles: > 0 } size
                && Ask(
                    $"Get {Count(size.NewFiles, "file")} from {Path.GetFileName(paths[0].TrimEnd('\\'))} that aren't on this computer yet "
                        + $"({FormatSize(size.Bytes)})?{RoomLeft(workspace.Root)}",
                    defaultNo: true) != DialogResult.Yes)
            {
                return null;
            }
            var notInVault = new List<string>();
            var result = await GetUpdatingOpenAsync(workspace, async () =>
            {
                var got = await workspace.GetLatestAsync(paths);
                foreach (var path in folder ? Array.Empty<string>() : paths.Where(SolidWorksHost.IsSolidWorksFile))
                {
                    var (used, missing) = await workspace.GetUsedFilesAsync(path, _sw.KeptReferences, latest: true);
                    got.Add(used);
                    notInVault.AddRange(missing.Except(notInVault, StringComparer.OrdinalIgnoreCase).ToList());
                }
                return got;
            });
            return Summary(result) + NotInVaultNote(notInVault);
        });

    /// <summary>
    /// Get files (get does it), updating open documents in place. Open documents with unsaved changes are
    /// left alone and show up as files that couldn't be updated.
    /// </summary>
    private async Task<GetResult> GetUpdatingOpenAsync(Workspace workspace, Func<Task<GetResult>> get)
    {
        var open = _sw.OpenDocuments().Select(SolidWorksHost.PathOf).Where(p => p != null).Cast<string>();
        var stale = (await CurrentStatusAsync(workspace, open))
            .Where(s => s.State == FileState.Outdated && !_sw.HasUnsavedChanges(s.LocalPath)).Select(s => s.LocalPath).ToList();
        return await ReplacingAsync(stale, get);
    }

    // " C: has 120 GB free.", or nothing if Windows won't say.
    private static string RoomLeft(string root)
    {
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(root));
            return $" {drive.Name.TrimEnd('\\')} has {FormatSize(drive.AvailableFreeSpace)} free.";
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private static string FormatSize(long bytes)
    {
        string[] units = { "bytes", "KB", "MB", "GB", "TB" };
        double value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return unit == 0 ? $"{bytes} bytes" : value.ToString(value < 10 ? "0.0" : "0", CultureInfo.InvariantCulture) + " " + units[unit];
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
        ShowMessage(doing + "...", Tone.Info);
        try
        {
            ShowMessage(await action(workspace) ?? "", Tone.Good);
        }
        catch (VaultApiException e) when (e.StatusCode == 401)
        {
            _tokens.Remove(workspace.Server);
            OpenWorkspace();
            ShowMessage("Your sign-in expired. Sign in again.", Tone.Attention);
        }
        catch (Exception e) when (IsExpected(e))
        {
            Log.Error(doing + " failed", e);
            ShowMessage(Reason(e), Tone.Problem);
            Warn(Reason(e));
        }
        catch (Exception e)
        {
            Log.Error(doing + " failed", e);
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Tone.Problem);
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
            ShowAccount(workspace, me);
            // Redrawn only when something changed, so a refresh doesn't close what you had open in the tree.
            var shown = Signature(vault);
            if (shown != _shown)
            {
                _shown = shown;
                ShowChanges(vault.Files);
                ShowBrowse(vault);
            }
            ShowActiveDocument();
            await CheckForUpdateAsync(workspace);
        }
        catch (VaultApiException e) when (e.StatusCode == 401)
        {
            _tokens.Remove(workspace.Server);
            OpenWorkspace();
            ShowMessage("Your sign-in expired. Sign in again.", Tone.Attention);
        }
        catch (Exception e) when (IsExpected(e))
        {
            ShowMessage("Couldn't refresh: " + e.Message, Tone.Problem);
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
            Warn(Reason(e));
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
            Log.Error("A task pane action failed", e);
            ShowMessage(Reason(e), Tone.Problem);
        }
        catch (Exception e)
        {
            Log.Error("A task pane action failed", e);
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Tone.Problem);
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
            ShowMessage($"Something went wrong. Details are in {Log.FilePath}", Tone.Problem);
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

    // What went wrong, in words. A request that never got an answer only says "An error occurred while sending the
    // request"; why (the address can't be found, no secure connection could be made) is in the exception inside it.
    private static string Reason(Exception e)
    {
        if (e is not HttpRequestException)
        {
            return e.Message;
        }
        var inner = e;
        while (inner.InnerException != null)
        {
            inner = inner.InnerException;
        }
        return "Can't reach the Vault server: " + inner.Message;
    }

    private static bool IsExpected(Exception e) =>
        e is VaultApiException or WorkspaceException or VaultPathException or HttpRequestException
            or TimeoutException or TaskCanceledException or IOException or UnauthorizedAccessException or JsonException;

    private void OpenWorkspace()
    {
        _workspace?.Dispose();
        _workspace = null;
        _me = null;
        _statuses = new Dictionary<string, FileStatus>(StringComparer.Ordinal);
        Uri? server = null;
        var root = Workspace.FindRoot(_settings.WorkspaceRoot);
        if (root != null)
        {
            server = Workspace.ServerOf(root);
            var token = _tokens.Load(server);
            if (token != null)
            {
                _workspace = Workspace.Open(root, token, _sayWhenWorking);
            }
        }
        _serverBox.Text = server?.AbsoluteUri ?? _settings.Server ?? "";
        _rootBox.Text = root ?? _settings.WorkspaceRoot;
        _setupView.Visible = _workspace == null;
        _workView.Visible = _workspace != null;
        _refreshButton.Visible = _accountButton.Visible = _workspace != null;
        _newVersionButton.Visible = _workspace != null && _newerAddIn != null;
        _accountButton.Text = "Account ▾"; // until a refresh says who
        _vault = null;
        _shown = "";
        _changes.Items.Clear();
        _changesTab.Text = "Needs attention";
        _tree.Nodes.Clear();
        ShowView();
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

    private bool BrowseShown => _browseTab.Checked;

    // --- showing ------------------------------------------------------------------------------

    private void ShowActiveDocument() => ShowDocument(_sw.ActiveDocumentPath);

    /// <summary>
    /// The active document's card: its name, its status, what that means, and buttons for what you can do with it
    /// now, the one you're most likely to want first, in navy. Buttons that don't apply are hidden.
    /// </summary>
    private void ShowDocument(string? path)
    {
        var status = path == null ? null : StatusOf(path);
        _documentName.Text = path == null ? "No document open" : Path.GetFileName(path);
        _documentName.ForeColor = path == null ? Theme.Muted : Theme.Text;
        var (text, tone, detail) = DescribeDocument(path, status);
        _documentStatus.Show(text, tone);
        _documentStatus.Visible = text.Length > 0;
        _documentDetail.Text = detail;
        _documentDetail.Visible = detail.Length > 0;

        var inVault = status?.FileId != null;
        var mine = status?.CheckedOutByMe == true;
        // In conflict, only Keep mine and Use the vault's version settle it: Check in and Get latest would refuse or skip it.
        var conflict = status?.State == FileState.Conflict;
        var canCheckIn = status != null && (status.State == FileState.New || mine) && !conflict;
        var canCheckOut = inVault && status!.Lock == null && status.State is FileState.UpToDate or FileState.Outdated or FileState.Modified;
        var canGet = inVault && status!.State != FileState.DeletedInVault && !conflict;
        // Only where you may: most people never see it.
        var canTakeOver = status != null && _workspace?.CanTakeOver(status) == true;
        var yoursElsewhere = canTakeOver && status!.Lock!.User.Id == _me?.Id;
        var drawings = status != null && _vault != null ? _vault.Drawings(status) : Array.Empty<FileStatus>();
        // Caliper's 3D view, for parts and assemblies in the vault (check-ins make it too).
        var canMakeModel = inVault && Path.GetExtension(path ?? "").ToLowerInvariant() is ".sldprt" or ".sldasm";
        _takeOverButton.Text = yoursElsewhere ? "Move check-out here..." : "Take over...";
        _drawingButton.Text = drawings.Count > 1 ? "Open drawing ▾" : "Open drawing";
        var primary = canCheckIn ? _checkInButton
            : canGet && status!.State == FileState.Outdated ? _getButton
            : canCheckOut ? _checkOutButton
            : yoursElsewhere ? _takeOverButton
            : null;
        ShowActions(
            primary,
            (_checkInButton, canCheckIn),
            (_checkOutButton, canCheckOut),
            (_getButton, canGet),
            (_undoButton, mine),
            (_takeOverButton, canTakeOver),
            (_drawingButton, drawings.Count > 0),
            (_caliperButton, canMakeModel),
            (_keepMineButton, conflict),
            (_useVaultButton, conflict));
    }

    private void ShowActions(FlatButton? primary, params (FlatButton Button, bool Shown)[] actions)
    {
        var order = actions.Select(a => a.Button).OrderBy(b => b == primary ? 0 : 1).ToList();
        for (var i = 0; i < order.Count; i++)
        {
            if (_documentActions.Controls.GetChildIndex(order[i]) != i)
            {
                _documentActions.Controls.SetChildIndex(order[i], i);
            }
        }
        foreach (var (button, shown) in actions)
        {
            button.Visible = shown;
            button.Primary = button == primary;
            button.Enabled = !_busy;
        }
        _documentActions.Visible = actions.Any(a => a.Shown);
    }

    // What the card says about the active document: a few words for its badge, and what they mean.
    private (string Text, Tone Tone, string Detail) DescribeDocument(string? path, FileStatus? status)
    {
        if (path == null || _workspace == null)
        {
            return ("", Tone.Neutral, "Open a part, assembly, or drawing to see its status here, and check it out or in.");
        }
        if (!IsInWorkspace(path))
        {
            return ("Not in the vault", Tone.Muted, $"It's outside the workspace: save it in {_workspace.Root} to check it in.");
        }
        if (status == null)
        {
            return ("Checking...", Tone.Muted, "");
        }
        var (text, tone) = Describe(status);
        return (text, tone, Explain(status));
    }

    /// <summary>A file's status in a few words, and its tone: the same on the card, in the list, and in the tree.</summary>
    private (string Text, Tone Tone) Describe(FileStatus file) => file switch
    {
        { State: FileState.DeletedInVault } => ("Deleted in the vault", Tone.Problem),
        { State: FileState.Conflict } => ("Conflict", Tone.Problem),
        { State: FileState.New } => ("New", Tone.Info),
        { CheckedOutByMe: true, State: FileState.Modified } => ("Checked out to you, changed", Tone.Good),
        { CheckedOutByMe: true } => ("Checked out to you", Tone.Good),
        { Lock: { } yours } when yours.User.Id == _me?.Id => ("Checked out to you " + On(yours.Host), Tone.Attention),
        { Lock: { } other } => ($"Checked out by {other.User.Name} {On(other.Host)}", Tone.Attention),
        { State: FileState.Outdated } => ("Out of date", Tone.Attention),
        { State: FileState.Modified } => ("Changed, not checked out", Tone.Attention),
        { State: FileState.Missing } => ("Not downloaded", Tone.Muted),
        _ => ("Up to date", Tone.Neutral),
    };

    /// <summary>What a file's status means, and what to do about it: on the card, and over the lists' files.</summary>
    private string Explain(FileStatus file)
    {
        var version = file.RemoteVersion is int latest ? $"Version {latest}. " : "";
        return file switch
        {
            { State: FileState.DeletedInVault } => "Deleted from the vault since you got it. Restore it from the trash in the web app to keep working on it.",
            { State: FileState.Conflict } => $"Changed here, but version {file.RemoteVersion} was checked in since. Keep mine checks your copy "
                + "out, to check in on top of it; Use the vault's version replaces yours, keeping a copy of it.",
            { State: FileState.New } => "Not in the vault yet: check it in to add it.",
            { CheckedOutByMe: true, State: FileState.Modified } => version + "Check it in to share your changes as a new version.",
            { CheckedOutByMe: true } => version + "It's yours to change: check it in when you're done.",
            { Lock: { } yours } when yours.User.Id == _me?.Id =>
                version + $"You checked it out {On(yours.Host)}{Since(yours)}. Move the check-out here to change it on this computer.",
            { Lock: { } other } => version + $"{other.User.Name} checked it out {On(other.Host)}{Since(other)}, so you can't save changes to it."
                + (_workspace?.CanTakeOver(file) == true ? " As a lead here, you can take it over." : ""),
            { State: FileState.Outdated } => $"Version {file.LocalVersion} here, version {file.RemoteVersion} in the vault: get the latest to update it.",
            { State: FileState.Modified } => version + "Changed here, but not checked out: check it out to keep your changes.",
            { State: FileState.Missing } => version + "In the vault, not on this computer: opening it downloads it.",
            _ => version + "Read-only until you check it out.",
        };
    }

    // " since Oct 3 at 14:05", when a check-out started.
    private static string Since(FileLock fileLock) =>
        fileLock.Since == default ? "" : " since " + fileLock.Since.ToLocalTime().ToString("MMM d 'at' HH:mm", CultureInfo.InvariantCulture);

    private void ShowAccount(Workspace workspace, Account me)
    {
        var first = me.Name.Split(' ').FirstOrDefault(name => name.Length > 0) ?? "";
        _accountButton.Text = (first.Length > 0 ? first : "Account") + " ▾";
        _accountName.Text = me.Name;
        _accountEmail.Text = me.Email;
        _accountServer.Text = "Vault: " + workspace.Server.AbsoluteUri;
        _accountFolder.Text = $"Workspace: {workspace.Root}, on {workspace.Host}";
        _tips.SetToolTip(_accountButton, $"Signed in as {me.Name} ({me.Email}), on {workspace.Host}");
    }

    /// <summary>
    /// The files that need attention: yours, new ones, ones that are changed, out of date, or in trouble, and ones here
    /// that someone else has checked out. Files that aren't on this computer and aren't yours don't need you.
    /// </summary>
    private void ShowChanges(IReadOnlyList<FileStatus> statuses)
    {
        var attention = statuses
            .Where(s => s.CheckedOutByMe
                || s.State is FileState.New or FileState.Modified or FileState.Conflict or FileState.Outdated or FileState.DeletedInVault
                || (s.Lock != null && s.State != FileState.Missing))
            .OrderBy(s => s.CheckedOutByMe ? 0 : s.State == FileState.New ? 1 : s.State is FileState.Conflict or FileState.DeletedInVault ? 2 : 3)
            .ThenBy(s => s.VaultPath, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var selected = new HashSet<string>(
            _changes.SelectedItems.Cast<ListViewItem>().Select(i => ((FileStatus)i.Tag).VaultPath), StringComparer.OrdinalIgnoreCase);
        _changes.BeginUpdate();
        _changes.Items.Clear();
        foreach (var status in attention)
        {
            var (text, tone) = Describe(status);
            var item = new ListViewItem(NameOf(status.VaultPath), tone.ToString())
            {
                Tag = status,
                ToolTipText = status.VaultPath + "\n" + Explain(status),
                UseItemStyleForSubItems = false,
                Selected = selected.Contains(status.VaultPath),
            };
            item.SubItems.Add(text, tone == Tone.Neutral ? Theme.Muted : Theme.Ink(tone), _changes.BackColor, _changes.Font);
            item.SubItems.Add(FolderPath(status.VaultPath), Theme.Muted, _changes.BackColor, _changes.Font);
            _changes.Items.Add(item);
        }
        _changes.EndUpdate();
        _changesTab.Text = attention.Count == 0 ? "Needs attention" : $"Needs attention ({attention.Count})";
        ShowView();
    }

    // The list or the tree, by the tab that's chosen. An empty list says so.
    private void ShowView()
    {
        var browse = _browseTab.Checked;
        var empty = _changes.Items.Count == 0;
        _tree.Visible = browse;
        _changes.Visible = !browse && !empty;
        _changesEmpty.Visible = !browse && empty;
        _changesEmpty.Text = _vault == null ? "Loading..." : "Nothing needs your attention.\nEverything here is up to date.";
    }

    // The task pane's width depends on SolidWorks and the display, so the columns share whatever
    // width the list has instead of overflowing it (at 100%) or leaving most of it empty (at 250%).
    private void FitColumns()
    {
        var width = _changes.ClientSize.Width;
        _changes.Columns[0].Width = width * 2 / 5;
        _changes.Columns[1].Width = width * 2 / 5;
        _changes.Columns[2].Width = width - _changes.Columns[0].Width - _changes.Columns[1].Width;
    }

    private static string Summary(GetResult result)
    {
        var parts = new List<string> { $"Got {Count(result.Downloaded.Count, "file")}." };
        if (result.Removed.Count > 0)
        {
            parts.Add($"Removed {Count(result.Removed.Count, "file")} deleted from the vault.");
        }
        if (result.Skipped.Count > 0)
        {
            parts.Add($"Skipped {Count(result.Skipped.Count, "file")} changed here: Needs attention says what to do with each.");
        }
        if (result.Failures.Count > 0)
        {
            parts.Add("Couldn't update: " + string.Join("; ", result.Failures));
        }
        return string.Join(" ", parts);
    }

    private static string Count(int count, string noun) =>
        count == 1 ? $"1 {noun}" : count.ToString("N0", CultureInfo.InvariantCulture) + $" {noun}s";

    private void SetBusy(bool busy)
    {
        _busy = busy;
        UseWaitCursor = busy;
        _activity.Running = busy;
        _lists.Enabled = !busy;
        _refreshButton.Enabled = _updateButton.Enabled = _everythingButton.Enabled = _freeUpButton.Enabled = !busy;
        ShowActiveDocument();
    }

    // Only the first line: a list after it is for the message box.
    private void ShowMessage(string text, Tone tone)
    {
        _message.Text = text.Split('\n')[0].TrimEnd('\r');
        _message.ForeColor = tone == Tone.Neutral ? Theme.Muted : Theme.Ink(tone);
        _statusBar.Visible = _message.Text.Length > 0;
    }

    private void Warn(string text) => MessageDialog.Show(this, text, MessageBoxButtons.OK, MessageBoxIcon.Warning);

    // For a question with a big answer (a download of many files), No is the default, so Enter doesn't start it.
    private DialogResult Ask(string question, bool defaultNo = false) =>
        MessageDialog.Show(
            this,
            question,
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            defaultNo ? MessageBoxDefaultButton.Button2 : MessageBoxDefaultButton.Button1);

    /// <summary>
    /// Open files, SolidWorks' own in SolidWorks. One that isn't here yet is got first, with the parts it uses; one
    /// that is, with the parts it uses that aren't, at every level.
    /// </summary>
    private async Task OpenAsync(IReadOnlyList<string> paths)
    {
        foreach (var path in paths)
        {
            if (!File.Exists(path) && StatusOf(path)?.FileId != null)
            {
                await GetLatestAsync(path);
            }
            else if (File.Exists(path) && SolidWorksHost.IsSolidWorksFile(path))
            {
                await GetWhatItUsesAsync(path);
            }
            if (!File.Exists(path))
            {
                continue;
            }
            if (SolidWorksHost.IsSolidWorksFile(path))
            {
                if (_sw.Open(path) is { } problem)
                {
                    ShowMessage(problem, Tone.Problem);
                    Warn(problem);
                }
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
            var choice = new ContextMenuStrip { Renderer = Theme.MenuRenderer };
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

    private void OpenWebApp()
    {
        if (_workspace != null)
        {
            OpenInBrowser(_workspace.Server);
        }
    }

    private static void OpenInBrowser(Uri url) => Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });

    private static Uri ParseServer(string text) =>
        Uri.TryCreate(text.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            ? uri
            : throw new WorkspaceException("Enter the server's address, like https://yjsp.example.org");

    // The server SolidWorks last signed in to, if any: what it's set up for when there's no workspace (OpenLink.ConnectQuestion).
    private Uri? LastServer => Uri.TryCreate(_settings.Server, UriKind.Absolute, out var server) ? server : null;

    /// <summary>Right-click actions on what's selected in the list or the tree (a folder in the tree gets its own few).</summary>
    private ContextMenuStrip ItemMenu()
    {
        var menu = new ContextMenuStrip { Renderer = Theme.MenuRenderer, ShowItemToolTips = true };
        var open = menu.Items.Add("Open", null, (_, _) => Safely(() => OpenAsync(SelectedPaths())));
        var drawing = new ToolStripMenuItem("Open drawing");
        menu.Items.Add(drawing);
        var insert = menu.Items.Add("Insert into assembly", null, (_, _) => Safely(() => InsertAsync(SelectedPaths()[0])));
        var checkOut = menu.Items.Add("Check out", null, (_, _) => Safely(() => CheckOutAsync(SelectedPaths())));
        var checkIn = menu.Items.Add("Check in...", null, (_, _) => Safely(() => CheckInAsync(SelectedPaths())));
        var undo = menu.Items.Add("Undo check-out", null, (_, _) => Safely(() => UndoAsync(SelectedPaths()[0])));
        var get = menu.Items.Add("Get latest", null, (_, _) => Safely(() =>
            GetSelectedAsync(SelectedPaths(), BrowseShown && _tree.SelectedNode?.Tag is TreeFolder)));
        var takeOver = menu.Items.Add("Take over...", null, (_, _) => Safely(() => TakeOverAsync(SelectedPaths()[0])));
        var keepMine = menu.Items.Add("Keep mine...", null, (_, _) => Safely(() => KeepMineAsync(SelectedPaths())));
        var useVault = menu.Items.Add("Use the vault's version...", null, (_, _) => Safely(() => UseVaultVersionAsync(SelectedPaths())));
        var freeUp = menu.Items.Add("Free up space...", null, (_, _) => Safely(() => FreeUpSpaceAsync(SelectedPaths())));
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
            get.ToolTipText = folder
                ? "Download the newest version of every file in this folder. Vault asks first if that's files you don't have yet."
                : "Download the newest version, with the parts it uses. Open files update in place.";
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
            // A part or assembly goes in the active assembly; files deleted in the vault, or in conflict, couldn't be
            // checked in with it.
            var assembly = ActiveAssembly();
            var component = files.Count == 1 && SolidWorksHost.IsComponent(files[0].VaultPath) ? files[0] : null;
            insert.Available = !folder && component != null;
            insert.Text = assembly == null ? "Insert into an assembly (open one first)" : $"Insert into {Path.GetFileName(assembly)}";
            insert.Enabled = !_busy && assembly != null && component != null
                && component.State is not (FileState.DeletedInVault or FileState.Conflict)
                && !string.Equals(component.LocalPath, assembly, StringComparison.OrdinalIgnoreCase);
            insert.ToolTipText = "Download it if it isn't here, with the parts it uses, and add it to the assembly, ready to mate.";
            // A folder's copies here, or these files', if any are as they came and not checked out to you.
            freeUp.Enabled = !_busy && (folder || files.Any(s => s.FileId != null && !s.CheckedOutByMe
                && s.State is FileState.UpToDate or FileState.Outdated));
            freeUp.ToolTipText = "Remove the copies on this computer. They stay in the vault, and download again when you open them.";
            // Changed here, and a newer version in the vault since: keep yours, or take the vault's.
            keepMine.Available = useVault.Available = !folder && files.Any(s => s.State == FileState.Conflict);
            keepMine.Enabled = useVault.Enabled = !_busy;
            keepMine.ToolTipText = "Check your copy out as it is, to check it in on top of the vault's version, which stays in the history.";
            useVault.ToolTipText = "Replace your copy with the vault's latest version. Yours is kept in the workspace's .vault\\backup folder.";
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

    private static TreeNode Placeholder() => new TreeNode("...") { Tag = Unfilled, ImageKey = Theme.NoImage, SelectedImageKey = Theme.NoImage };

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
            var node = nodes.Add(
                "d:" + VaultPaths.Key(child.VaultPath),
                child.CheckedOut > 0 ? $"{child.Name}   ({child.CheckedOut} checked out)" : child.Name,
                Theme.FolderImage,
                Theme.FolderImage);
            node.Tag = child;
            node.ToolTipText = child.VaultPath;
            if (child.Folders.Count + child.Files.Count > 0)
            {
                node.Nodes.Add(Placeholder());
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
        var (state, tone) = Describe(file);
        text.Append("   ").Append(version.Length > 0 ? version + " · " : "").Append(state);
        var node = new TreeNode(text.ToString())
        {
            Name = key,
            Tag = new BrowseItem(file),
            ImageKey = tone.ToString(),
            SelectedImageKey = tone.ToString(),
            // The dot says the rest; only trouble, and files that aren't here, change the text's color.
            ForeColor = tone is Tone.Problem or Tone.Muted ? Theme.Ink(tone) : _tree.ForeColor,
            ToolTipText = TipFor(file),
        };
        // A drawing listed under its model is a link to it: what it shows is already there, above it.
        if (!drawing && _vault != null && ((_vault.Uses(file)?.Count ?? 0) > 0 || _vault.Drawings(file).Count > 0))
        {
            node.Nodes.Add(Placeholder());
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
                node.Nodes.Add(new TreeNode("A file deleted from the vault")
                {
                    Name = $"{node.Name}/{used.FileId}",
                    ImageKey = Theme.NoImage,
                    SelectedImageKey = Theme.NoImage,
                    ForeColor = Theme.Muted,
                });
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

    private string TipFor(FileStatus file)
    {
        var lines = new List<string> { file.VaultPath, Explain(file) };
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

    private static string FolderOf(string vaultPath) => FolderPath(vaultPath) is { Length: > 0 } folder ? folder : "the top folder";

    private static string FolderPath(string vaultPath) => vaultPath.LastIndexOf('/') is var slash and > 0 ? vaultPath.Substring(0, slash) : "";

    // --- layout -------------------------------------------------------------------------------

    // Vault's mark and name, and once you're signed in, refresh and your account's menu.
    private Control Header()
    {
        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 6,
            RowCount = 1,
            BackColor = Theme.Surface,
            Padding = new Padding(10, 6, 6, 6),
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(
            new PictureBox
            {
                Image = Icons.Draw(64),
                SizeMode = PictureBoxSizeMode.Zoom,
                Size = new Size(22, 22),
                Anchor = AnchorStyles.Left,
                Margin = new Padding(0, 0, 8, 0),
            },
            0,
            0);
        var title = Words("Vault", Theme.Title, Theme.Accent);
        title.Dock = DockStyle.None;
        title.Anchor = AnchorStyles.Left;
        title.Margin = new Padding(0);
        header.Controls.Add(title, 1, 0);
        _newVersionButton.Anchor = _refreshButton.Anchor = _accountButton.Anchor = AnchorStyles.Right;
        header.Controls.Add(_newVersionButton, 3, 0);
        header.Controls.Add(_refreshButton, 4, 0);
        header.Controls.Add(_accountButton, 5, 0);
        return header;
    }

    private Control SignInView()
    {
        var card = new Card();
        card.Add(Words("Sign in to Vault", Theme.Heading));
        card.Add(Words("Check SolidWorks files in and out of the team's vault, see who's changing what, and open assemblies with everything they use."));
        card.Add(Words("Quickest: on the web app's SolidWorks page, click Connect SolidWorks.", color: Theme.Muted));
        card.Add(Spaced(Words("Server address", Theme.Bold)));
        card.Add(_serverBox);
        card.Add(Words("Workspace folder", Theme.Bold));
        card.Add(_rootBox);
        card.Add(Words("Use the same folder on every computer, so assemblies find their parts.", color: Theme.Muted));
        card.Add(Spaced(Row(_signInButton)));
        return Stack(null, card);
    }

    // The active document's card, the tabs over the files, the files, and what gets files for the whole workspace.
    private Control WorkView()
    {
        _documentCard.Add(Words("Active document", Theme.Caption, Theme.Muted));
        _documentCard.Add(_documentName);
        var status = Row(_documentStatus);
        status.Margin = new Padding(0, 2, 0, 4);
        _documentCard.Add(status);
        _documentCard.Add(_documentDetail);
        _documentCard.Add(_documentActions);

        var files = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Surface, Margin = new Padding(0) };
        files.Controls.Add(_tree);
        files.Controls.Add(_changes);
        files.Controls.Add(_changesEmpty);
        _lists.Add(files, fill: true);

        var tabs = Row(_changesTab, _browseTab);
        var footer = Row(_updateButton, _everythingButton, _freeUpButton);
        return Stack(_lists, _documentCard, tabs, _lists, footer);
    }

    private Control StatusBar()
    {
        var bar = new TableLayoutPanel
        {
            Dock = DockStyle.Bottom,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            BackColor = Theme.Surface,
            Padding = new Padding(10, 6, 10, 4),
            Visible = false,
        };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bar.Controls.Add(_message);
        bar.Paint += (_, e) =>
        {
            using var line = new Pen(Theme.Border);
            e.Graphics.DrawLine(line, 0, 0, bar.Width, 0);
        };
        return bar;
    }

    private static TableLayoutPanel Stack(Control? fill, params Control[] controls)
    {
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoScroll = true,
            BackColor = Theme.Background,
            Padding = new Padding(8, 8, 8, 2),
        };
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
        var row = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = true,
            Margin = new Padding(0),
        };
        row.Controls.AddRange(controls);
        return row;
    }

    private static T Spaced<T>(T control)
        where T : Control
    {
        control.Margin = new Padding(control.Margin.Left, control.Margin.Top + 8, control.Margin.Right, control.Margin.Bottom);
        return control;
    }

    // Text that wraps to the width it's given, which already scales with the display.
    private static Label Words(string text, Font? font = null, Color? color = null) =>
        new Label
        {
            Text = text,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Font = font ?? Theme.Base,
            ForeColor = color ?? Theme.Text,
            UseCompatibleTextRendering = false,
            Margin = new Padding(0, 0, 0, 4),
        };

    private static TextBox Field() => new TextBox { Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 2, 0, 8) };

    // A tab over the files: the chosen one is white, like the files under it.
    private static RadioButton Tab(string text)
    {
        var tab = new RadioButton
        {
            Text = text,
            Appearance = Appearance.Button,
            FlatStyle = FlatStyle.Flat,
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleCenter,
            MinimumSize = new Size(0, 28),
            Padding = new Padding(8, 0, 8, 0),
            Margin = new Padding(0, 0, 4, 6),
            UseCompatibleTextRendering = false,
            BackColor = Theme.Background,
            ForeColor = Theme.Muted,
        };
        tab.FlatAppearance.BorderSize = 1;
        tab.FlatAppearance.BorderColor = Theme.Background;
        tab.FlatAppearance.CheckedBackColor = Theme.Surface;
        tab.FlatAppearance.MouseOverBackColor = Theme.Hover;
        tab.FlatAppearance.MouseDownBackColor = Theme.Pressed;
        tab.CheckedChanged += (_, _) =>
        {
            tab.ForeColor = tab.Checked ? Theme.Accent : Theme.Muted;
            tab.FlatAppearance.BorderColor = tab.Checked ? Theme.Border : Theme.Background;
        };
        return tab;
    }

    private FlatButton MakeButton(string text, EventHandler onClick, string tip)
    {
        var button = new FlatButton(text);
        button.Click += onClick;
        _tips.SetToolTip(button, tip);
        return button;
    }

    // A button in the header: an icon from Windows' icon font, or its name where that font is missing.
    private static FlatButton IconButton(string glyph, string name, EventHandler onClick)
    {
        var button = new FlatButton(Theme.Glyphs == null ? name : glyph)
        {
            Quiet = true,
            AccessibleName = name,
            MinimumSize = new Size(28, 28),
            Padding = new Padding(0),
            Margin = new Padding(2, 0, 0, 0),
        };
        if (Theme.Glyphs != null)
        {
            button.Font = Theme.Glyphs;
        }
        button.Click += onClick;
        return button;
    }
}

/// <summary>What to do when SolidWorks is about to show Save As (see <see cref="VaultPane.BeforeSaveAs"/>).</summary>
internal enum SaveAsChoice
{
    /// <summary>Let SolidWorks ask for a name, as usual.</summary>
    ShowDialog,

    /// <summary>Save to the document's own file, which is checked out to you now.</summary>
    SaveInPlace,

    /// <summary>Don't save.</summary>
    Cancel,
}
