using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using Vault.Client;

namespace Vault.SolidWorks;

/// <summary>
/// A new part or assembly that takes a part number: what kind it is (from the kinds that fit) and what it's called (its
/// title). Its name is the number the vault hands out next.
/// </summary>
internal sealed class NewNumberDialog : Form
{
    private readonly ComboBox _kind = new ComboBox
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        Dock = DockStyle.Fill,
        Margin = new Padding(0, 4, 0, 8),
    };

    private readonly TextBox _title = new TextBox
    {
        Dock = DockStyle.Fill,
        BorderStyle = BorderStyle.FixedSingle,
        MaxLength = 200,
        Margin = new Padding(0, 4, 0, 8),
    };

    private readonly List<PartKind> _kinds;

    public NewNumberDialog(string what, string folder, IReadOnlyList<PartKind> kinds)
    {
        _kinds = kinds.ToList();
        SuspendLayout();
        Text = $"New {what}";
        Font = Theme.Base;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(440, 270);
        Padding = new Padding(16, 12, 16, 12);

        var heading = Dialogs.Words($"New {what} in {(folder.Length > 0 ? folder : "the top folder")}", Theme.Heading, Theme.Text);
        _kind.Items.AddRange(_kinds.Select(k => (object)$"{k.Code} {k.Label}").ToArray());
        if (_kinds.Count > 0)
        {
            _kind.SelectedIndex = 0;
        }
        var explain = Dialogs.Words(
            "Its name is its part number, which the vault hands out in order and which never changes; its title says what it "
            + "is. SolidWorks starts it from your default template, and it's checked in, checked out to you.",
            Theme.Base,
            Theme.Muted);
        var ok = Dialogs.Button("Start it", DialogResult.OK);
        ok.Primary = true;
        ok.Enabled = false;
        var cancel = Dialogs.Button("Cancel", DialogResult.Cancel);
        _title.TextChanged += (_, _) => ok.Enabled = Title.Length > 0 && _kind.SelectedIndex >= 0;
        Controls.Add(Dialogs.Layout(
            heading,
            Dialogs.Words("Kind", Theme.Bold, Theme.Text),
            _kind,
            Dialogs.Words("Title", Theme.Bold, Theme.Text),
            _title,
            explain,
            Dialogs.Buttons(ok, cancel)));
        AcceptButton = ok;
        CancelButton = cancel;
        ActiveControl = _title;
        // Sizes are for a 100% (96 DPI) display; SolidWorks is DPI-aware, so this scales them.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(false);
        PerformLayout();
    }

    /// <summary>The kind's code: 001.</summary>
    public string Kind => _kind.SelectedIndex >= 0 ? _kinds[_kind.SelectedIndex].Code : "";

    public string Title => _title.Text.Trim();
}
