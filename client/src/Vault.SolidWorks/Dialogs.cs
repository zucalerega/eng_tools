using System.Drawing;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>The pieces of Vault's small dialogs (TitleDialog, NewNumberDialog), laid out as CheckinDialog is.</summary>
internal static class Dialogs
{
    public static Label Words(string text, Font font, Color color) =>
        new Label
        {
            Text = text,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Font = font,
            ForeColor = color,
            UseCompatibleTextRendering = false,
            Margin = new Padding(0, 0, 0, 4),
        };

    public static FlatButton Button(string text, DialogResult result) =>
        new FlatButton(text) { DialogResult = result, MinimumSize = new Size(88, 30), Margin = new Padding(8, 0, 0, 0) };

    /// <summary>The buttons, right to left from the last: OK, then Cancel at the right edge.</summary>
    public static FlowLayoutPanel Buttons(params FlatButton[] buttons)
    {
        var row = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0, 4, 0, 0),
        };
        for (var i = buttons.Length - 1; i >= 0; i--)
        {
            row.Controls.Add(buttons[i]);
        }
        return row;
    }

    /// <summary>The rows, one under another, the whole width of the dialog.</summary>
    public static TableLayoutPanel Layout(params Control[] rows)
    {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = rows.Length };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < rows.Length; i++)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(rows[i], 0, i);
        }
        return layout;
    }
}
