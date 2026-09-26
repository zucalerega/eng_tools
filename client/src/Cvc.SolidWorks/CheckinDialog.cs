using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Cvc.SolidWorks;

/// <summary>Asks what changed. A comment is required: it's what people read in the history.</summary>
internal sealed class CheckinDialog : Form
{
    private readonly TextBox _comment = new TextBox { Multiline = true, AcceptsReturn = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
    private readonly CheckBox _keep = new CheckBox { Text = "Keep checked out (to keep working on them)", AutoSize = true };

    public CheckinDialog(IEnumerable<string> fileNames)
    {
        SuspendLayout();
        Text = "Check in";
        Font = SystemFonts.MessageBoxFont;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(460, 280);
        Padding = new Padding(10);

        var names = fileNames.ToList();
        var shown = string.Join(", ", names.Take(4)) + (names.Count > 4 ? $" and {names.Count - 4} more" : "");
        var prompt = new Label
        {
            Text = $"What changed in {shown}? New parts and changed parts they use go in too.",
            AutoSize = true,
            MaximumSize = new Size(440, 0),
            Dock = DockStyle.Fill,
        };
        var ok = DialogButton("Check in", DialogResult.OK);
        ok.Enabled = false;
        var cancel = DialogButton("Cancel", DialogResult.Cancel);
        _comment.TextChanged += (_, _) => ok.Enabled = _comment.Text.Trim().Length > 0;

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(prompt, 0, 0);
        layout.Controls.Add(_comment, 0, 1);
        layout.Controls.Add(_keep, 0, 2);
        layout.Controls.Add(buttons, 0, 3);
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

    // Sized by their text (at least Windows' standard 75x23), which already scales with the display.
    // GrowAndShrink keeps the DPI scaling from leaving them enlarged, as GrowOnly (the default) would.
    private static Button DialogButton(string text, DialogResult result) =>
        new Button { Text = text, DialogResult = result, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(75, 23) };
}
