using System.Drawing;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>Asks what a file is called: its title, shown with its name. Changing it isn't a new version.</summary>
internal sealed class TitleDialog : Form
{
    private readonly TextBox _title = new TextBox
    {
        Dock = DockStyle.Fill,
        BorderStyle = BorderStyle.FixedSingle,
        MaxLength = 200,
        Margin = new Padding(0, 4, 0, 8),
    };

    public TitleDialog(string fileName, string title)
    {
        SuspendLayout();
        Text = "Title";
        Font = Theme.Base;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(420, 170);
        Padding = new Padding(16, 12, 16, 12);

        var heading = Dialogs.Words($"Title of {fileName}", Theme.Heading, Theme.Text);
        var prompt = Dialogs.Words(
            "What people call it, shown with its name. Its name stays, and so does the file: changing the title isn't a "
            + "new version, and doesn't need it checked out.",
            Theme.Base,
            Theme.Muted);
        _title.Text = title;
        var ok = Dialogs.Button("Save", DialogResult.OK);
        ok.Primary = true;
        var cancel = Dialogs.Button("Cancel", DialogResult.Cancel);
        _title.TextChanged += (_, _) => ok.Enabled = Title.Length > 0 && Title != title;
        ok.Enabled = false;
        Controls.Add(Dialogs.Layout(heading, prompt, _title, Dialogs.Buttons(ok, cancel)));
        AcceptButton = ok;
        CancelButton = cancel;
        // Sizes are for a 100% (96 DPI) display; SolidWorks is DPI-aware, so this scales them.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(false);
        PerformLayout();
    }

    public string Title => _title.Text.Trim();
}
