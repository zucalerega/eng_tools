using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>Asks what changed. A comment is required: it's what people read in the history.</summary>
internal sealed class CheckinDialog : Form
{
    private readonly TextBox _comment = new TextBox
    {
        Multiline = true,
        AcceptsReturn = true,
        Dock = DockStyle.Fill,
        ScrollBars = ScrollBars.Vertical,
        BorderStyle = BorderStyle.FixedSingle,
        Margin = new Padding(0, 4, 0, 8),
    };

    private readonly CheckBox _keep = new CheckBox
    {
        Text = "Keep them checked out, to keep working on them",
        AutoSize = true,
        UseCompatibleTextRendering = false,
        Margin = new Padding(0, 0, 0, 4),
    };

    public CheckinDialog(IEnumerable<string> fileNames)
    {
        SuspendLayout();
        Text = "Check in";
        Font = Theme.Base;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(460, 300);
        Padding = new Padding(16, 12, 16, 12);

        var names = fileNames.ToList();
        var shown = string.Join(", ", names.Take(4)) + (names.Count > 4 ? $" and {names.Count - 4} more" : "");
        var heading = Words(names.Count == 1 ? "Check in 1 file" : $"Check in {names.Count} files", Theme.Heading, Theme.Text);
        var files = Words(shown, Theme.Base, Theme.Muted);
        var prompt = Words("What changed? People read this in the history. New parts, and parts you changed, that these use go in too.", Theme.Base, Theme.Text);
        prompt.Margin = new Padding(0, 8, 0, 0);
        var ok = DialogButton("Check in", DialogResult.OK);
        ok.Primary = true;
        ok.Enabled = false;
        var cancel = DialogButton("Cancel", DialogResult.Cancel);
        _comment.TextChanged += (_, _) => ok.Enabled = _comment.Text.Trim().Length > 0;

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0, 4, 0, 0),
        };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(heading, 0, 0);
        layout.Controls.Add(files, 0, 1);
        layout.Controls.Add(prompt, 0, 2);
        layout.Controls.Add(_comment, 0, 3);
        layout.Controls.Add(_keep, 0, 4);
        layout.Controls.Add(buttons, 0, 5);
        Controls.Add(layout);
        AcceptButton = ok;
        CancelButton = cancel;
        // The sizes above are for a 100% (96 DPI) display. SolidWorks is DPI-aware, so Windows doesn't
        // scale its windows for us, and at 250% the text crowded the comment box down to nothing.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(false);
        PerformLayout();
    }

    public string Comment => _comment.Text.Trim();

    public bool KeepCheckedOut => _keep.Checked;

    private static Label Words(string text, Font font, Color color) =>
        new Label
        {
            Text = text,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Font = font,
            ForeColor = color,
            UseCompatibleTextRendering = false,
            Margin = new Padding(0, 0, 0, 2),
        };

    private static FlatButton DialogButton(string text, DialogResult result) =>
        new FlatButton(text) { DialogResult = result, MinimumSize = new Size(88, 30), Margin = new Padding(8, 0, 0, 0) };
}
