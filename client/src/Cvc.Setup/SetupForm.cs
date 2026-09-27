using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Cvc.SolidWorks;

namespace Cvc.Setup;

/// <summary>Setup's one window: what it's about to do, a button to do it, then how it went.</summary>
internal sealed class SetupForm : Form
{
    private readonly bool _uninstall;
    private readonly Label _text = new Label { AutoSize = true, MaximumSize = new Size(440, 0), Margin = new Padding(0, 0, 0, 12) };
    private readonly Label _status = new Label { AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = SystemColors.GrayText };
    private readonly ProgressBar _progress = new ProgressBar { Style = ProgressBarStyle.Marquee, Width = 440, Visible = false };
    private readonly Button _go = new Button { AutoSize = true, MinimumSize = new Size(96, 0) };
    private readonly Button _close = new Button { AutoSize = true, MinimumSize = new Size(96, 0), Text = "Cancel" };
    private bool _done;

    /// <summary>Whether the add-in was removed, so setup's own copy can go once it closes.</summary>
    public bool Uninstalled => _uninstall && _done;

    public SetupForm(bool uninstall)
    {
        _uninstall = uninstall;
        Text = uninstall ? "Remove " + Installer.Product : Installer.Product + " setup";
        Font = SystemFonts.MessageBoxFont;
        AutoScaleMode = AutoScaleMode.Font;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = SystemColors.Window;
        using (var mark = Icons.Draw(32))
        {
            Icon = Icon.FromHandle(mark.GetHicon());
        }

        var installed = Installer.InstalledVersion;
        if (uninstall)
        {
            _text.Text = "This removes the Vault add-in from SolidWorks, and the Vault links from this computer. "
                + "Your workspace (C:\\CVC), your files in it, and your sign-in stay.";
            _go.Text = "Remove";
        }
        else
        {
            _text.Text = "This installs the Vault add-in for SolidWorks 2025, in " + Installer.Folder + ". "
                + "Vault gets a tab in SolidWorks' task pane, and the web app's Open in SolidWorks buttons start working."
                + (installed == null ? "" : $"\n\nVersion {installed} is installed now: this puts version {Installer.Version} in its place.");
            _go.Text = installed == null ? "Install" : installed == Installer.Version ? "Reinstall" : "Update";
        }
        _go.Click += async (_, _) => await RunAsync();
        _close.Click += (_, _) => Close();
        AcceptButton = _go;
        CancelButton = _close;

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 16, 0, 0),
        };
        buttons.Controls.AddRange(new Control[] { _close, _go });
        var body = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Padding = new Padding(20, 16, 20, 16), Dock = DockStyle.Fill };
        body.Controls.Add(_text);
        body.Controls.Add(_status);
        body.Controls.Add(_progress);
        body.Controls.Add(buttons);
        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        layout.Controls.Add(Header());
        layout.Controls.Add(body);
        Controls.Add(layout);
    }

    /// <summary>Vault's mark and name, on navy, as at the top of the web app.</summary>
    private static Control Header()
    {
        var header = new TableLayoutPanel
        {
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 2,
            Dock = DockStyle.Fill,
            BackColor = Icons.Navy,
            Padding = new Padding(16, 14, 20, 14),
            Margin = new Padding(0),
        };
        var mark = new PictureBox { Image = Icons.Draw(48), SizeMode = PictureBoxSizeMode.AutoSize, Margin = new Padding(0, 0, 12, 0) };
        header.Controls.Add(mark, 0, 0);
        header.SetRowSpan(mark, 2);
        header.Controls.Add(new Label
        {
            Text = "Vault for SolidWorks",
            AutoSize = true,
            ForeColor = Color.White,
            Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 14f, FontStyle.Bold),
            Margin = new Padding(0, 2, 0, 0),
        }, 1, 0);
        header.Controls.Add(new Label { Text = "Yellow Jacket Space Program", AutoSize = true, ForeColor = Icons.Gold }, 1, 1);
        return header;
    }

    private async Task RunAsync()
    {
        if (_done)
        {
            Close();
            return;
        }
        while (Installer.SolidWorksRunning)
        {
            var answer = MessageBox.Show(
                this,
                "Close SolidWorks first: it has the add-in loaded. Then click Retry.",
                Text,
                MessageBoxButtons.RetryCancel,
                MessageBoxIcon.Information);
            if (answer != DialogResult.Retry)
            {
                return;
            }
        }
        _go.Enabled = _close.Enabled = false;
        _progress.Visible = true;
        try
        {
            void Progress(string step) => BeginInvoke(new Action(() => _status.Text = step + "..."));
            await Task.Run(() =>
            {
                if (_uninstall)
                {
                    Installer.Uninstall(Progress);
                }
                else
                {
                    Installer.Install(Progress);
                }
            });
            _text.Text = _uninstall
                ? "Vault is removed from SolidWorks."
                : "Vault is installed.\n\nNext, connect it to your team's vault: in the Vault web app, go to SolidWorks (at the top) "
                    + "and click Connect SolidWorks. Or start SolidWorks, open the Vault tab in the task pane on the right, "
                    + "and sign in with the web app's address.";
            _status.Text = "";
            _go.Text = "Close";
            _done = true;
        }
        catch (Exception e) when (e is SetupException or UnauthorizedAccessException or System.IO.IOException or System.Security.SecurityException)
        {
            _status.ForeColor = Color.FromArgb(207, 34, 46);
            _status.Text = (_uninstall ? "Vault couldn't be removed: " : "Vault couldn't be installed: ") + e.Message;
        }
        finally
        {
            _progress.Visible = false;
            _go.Enabled = true;
            _close.Enabled = !_done;
        }
    }
}
