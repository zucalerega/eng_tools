using System;
using System.Collections.Generic;
using System.Drawing;
using System.Media;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>
/// Vault's message box, in place of Windows' (MessageBox), which grows with its text past the screen, where neither its
/// title bar nor its buttons can be reached, and can't scroll: a list of every file that changed in an assembly left
/// people stuck on one. This one is never taller than most of the screen it's on: a long message scrolls, and can be
/// selected and copied. It answers to the keys a message box does: Enter for the default button; Esc for Cancel, or for
/// No or OK where there's no Cancel; Y and N for Yes and No.
/// </summary>
internal sealed class MessageDialog : Form
{
    // The share of the screen's height (less the taskbar) it may take; the message scrolls inside the rest.
    private const double MostOfTheScreen = 0.8;

    private readonly TextBox _message = new TextBox
    {
        Multiline = true,
        ReadOnly = true,
        WordWrap = true,
        ScrollBars = ScrollBars.None,
        BorderStyle = BorderStyle.None,
        BackColor = Theme.Surface,
        ForeColor = Theme.Text,
        TabStop = false,
        Dock = DockStyle.Fill,
        Margin = new Padding(0, 6, 0, 8),
    };

    private readonly PictureBox _picture = new PictureBox
    {
        SizeMode = PictureBoxSizeMode.Zoom,
        Size = new Size(32, 32),
        Margin = new Padding(0, 4, 12, 0),
    };

    private readonly MessageBoxIcon _icon;
    private readonly IntPtr _owner;

    private MessageDialog(IntPtr owner, string text, MessageBoxButtons buttons, MessageBoxIcon icon, MessageBoxDefaultButton defaultButton)
    {
        _owner = owner;
        _icon = icon;
        SuspendLayout();
        Text = "Vault";
        Font = Theme.Base;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.Manual;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowIcon = false;
        ShowInTaskbar = false;
        ClientSize = new Size(520, 160);
        Padding = new Padding(16, 12, 16, 12);
        // A text box wants Windows' line ends.
        _message.Text = text.Replace("\r\n", "\n").Replace("\n", "\r\n");
        _picture.Image = IconFor(icon)?.ToBitmap();
        _picture.Visible = _picture.Image != null;

        var answers = new List<FlatButton>();
        FlatButton Answer(string label, DialogResult result)
        {
            var button = new FlatButton(label) { DialogResult = result, MinimumSize = new Size(88, 30), Margin = new Padding(8, 0, 0, 0) };
            answers.Add(button);
            return button;
        }
        FlatButton? no = null, ok = null, cancel = null;
        switch (buttons)
        {
            case MessageBoxButtons.YesNoCancel:
                Answer("&Yes", DialogResult.Yes);
                no = Answer("&No", DialogResult.No);
                cancel = Answer("Cancel", DialogResult.Cancel);
                break;
            case MessageBoxButtons.YesNo:
                Answer("&Yes", DialogResult.Yes);
                no = Answer("&No", DialogResult.No);
                break;
            case MessageBoxButtons.OKCancel:
                ok = Answer("OK", DialogResult.OK);
                cancel = Answer("Cancel", DialogResult.Cancel);
                break;
            default:
                ok = Answer("OK", DialogResult.OK);
                break;
        }
        var chosen = defaultButton switch
        {
            MessageBoxDefaultButton.Button2 when answers.Count > 1 => answers[1],
            MessageBoxDefaultButton.Button3 when answers.Count > 2 => answers[2],
            _ => answers[0],
        };
        chosen.Primary = true;
        AcceptButton = chosen;
        // Esc is the way out that changes the least, as in Windows' message box.
        CancelButton = cancel ?? no ?? ok;

        var row = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0),
        };
        for (var i = answers.Count - 1; i >= 0; i--)
        {
            row.Controls.Add(answers[i]); // right to left: the first answer ends up leftmost
        }
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(_picture, 0, 0);
        layout.Controls.Add(_message, 1, 0);
        layout.Controls.Add(row, 0, 1);
        layout.SetColumnSpan(row, 2);
        Controls.Add(layout);
        ActiveControl = chosen;
        // Sizes are for a 100% (96 DPI) display, as in the check-in dialog: SolidWorks is DPI-aware, so Windows doesn't
        // scale its windows for us.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ResumeLayout(false);
        PerformLayout();
    }

    /// <summary>Ask or tell, as MessageBox.Show does, over the window that owner is in; returns the answer.</summary>
    public static DialogResult Show(
        IWin32Window owner,
        string text,
        MessageBoxButtons buttons = MessageBoxButtons.OK,
        MessageBoxIcon icon = MessageBoxIcon.None,
        MessageBoxDefaultButton defaultButton = MessageBoxDefaultButton.Button1)
    {
        using var dialog = new MessageDialog(owner.Handle, text, buttons, icon, defaultButton);
        return dialog.ShowDialog(owner);
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e); // scaled for the display by now
        var screen = (_owner != IntPtr.Zero ? Screen.FromHandle(_owner) : Screen.FromControl(this)).WorkingArea;
        // As tall as the message needs, up to most of the screen; past that, it scrolls.
        var needed = TextRenderer.MeasureText(
            _message.Text + "\r\n",
            _message.Font,
            new Size(_message.ClientSize.Width - SystemInformation.VerticalScrollBarWidth, int.MaxValue),
            TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl).Height;
        var chrome = Height - _message.Height;
        Height = Math.Min((int)(screen.Height * MostOfTheScreen), chrome + Math.Max(needed, _picture.Height));
        if (_message.Height < needed)
        {
            _message.ScrollBars = ScrollBars.Vertical;
        }
        Location = new Point(screen.Left + ((screen.Width - Width) / 2), screen.Top + ((screen.Height - Height) / 2));
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // The sounds Windows' message box makes.
        var sound = _icon switch
        {
            MessageBoxIcon.Warning => SystemSounds.Exclamation,
            MessageBoxIcon.Error => SystemSounds.Hand,
            MessageBoxIcon.Question => SystemSounds.Question,
            MessageBoxIcon.Information => SystemSounds.Asterisk,
            _ => null,
        };
        sound?.Play();
    }

    private static Icon? IconFor(MessageBoxIcon icon) => icon switch
    {
        MessageBoxIcon.Warning => SystemIcons.Warning,
        MessageBoxIcon.Error => SystemIcons.Error,
        MessageBoxIcon.Question => SystemIcons.Question,
        MessageBoxIcon.Information => SystemIcons.Information,
        _ => null,
    };
}
