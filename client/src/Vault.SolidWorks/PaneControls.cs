using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>
/// A white panel with a rounded border, on the pane's gray: a column of controls, each sized to its contents
/// (<see cref="Add"/>), or one that fills what's left.
/// </summary>
internal sealed class Card : TableLayoutPanel
{
    public Card()
    {
        DoubleBuffered = true;
        ResizeRedraw = true;
        BackColor = Theme.Surface;
        ColumnCount = 1;
        ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Dock = DockStyle.Fill;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12, 10, 12, 10);
        Margin = new Padding(0, 0, 0, 8);
    }

    public void Add(Control control, bool fill = false)
    {
        RowStyles.Add(fill ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.AutoSize));
        RowCount = RowStyles.Count;
        Controls.Add(control, 0, RowStyles.Count - 1);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(Parent?.BackColor ?? Theme.Background);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), LogicalToDeviceUnits(6));
        using var fill = new SolidBrush(BackColor);
        using var line = new Pen(Theme.Border);
        graphics.FillPath(fill, shape);
        graphics.DrawPath(line, shape);
    }
}

/// <summary>A status as a badge: a dot and a few words in its tone's color, on its tint.</summary>
internal sealed class Pill : Control
{
    private Tone _tone;

    public Pill()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        AutoSize = true;
        Margin = new Padding(0, 0, 6, 0);
    }

    public void Show(string text, Tone tone)
    {
        _tone = tone;
        Text = text;
        Invalidate();
    }

    // As wide as its words, up to MaximumSize: past that they end in "...".
    public override Size GetPreferredSize(Size proposedSize)
    {
        var text = TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        var height = text.Height + LogicalToDeviceUnits(6);
        var width = TextLeft(height) + text.Width + LogicalToDeviceUnits(9);
        return new Size(MaximumSize.Width > 0 ? Math.Min(width, MaximumSize.Width) : width, height);
    }

    protected override void OnTextChanged(EventArgs e)
    {
        base.OnTextChanged(e);
        Size = GetPreferredSize(Size.Empty);
    }

    protected override void OnFontChanged(EventArgs e)
    {
        base.OnFontChanged(e);
        Size = GetPreferredSize(Size.Empty);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(Parent?.BackColor ?? Theme.Surface);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var ink = Theme.Ink(_tone);
        using (var tint = new SolidBrush(Theme.Tint(_tone)))
        using (var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Height / 2))
        {
            graphics.FillPath(tint, shape);
        }
        var dot = Dot(Height);
        using (var brush = new SolidBrush(ink))
        {
            graphics.FillEllipse(brush, LogicalToDeviceUnits(8), (Height - dot) / 2f, dot, dot);
        }
        var left = TextLeft(Height);
        TextRenderer.DrawText(
            graphics,
            Text,
            Font,
            new Rectangle(left, 0, Width - left, Height),
            ink,
            TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }

    private static int Dot(int height) => Math.Max(4, height / 3);

    private int TextLeft(int height) => LogicalToDeviceUnits(8) + Dot(height) + LogicalToDeviceUnits(5);
}

/// <summary>The list of files that need attention, drawn as File Explorer's are.</summary>
internal sealed class ThemedList : ListView
{
    public ThemedList()
    {
        DoubleBuffered = true; // no flicker as rows change
        View = View.Details;
        FullRowSelect = true;
        HideSelection = false;
        ShowItemToolTips = true;
        HeaderStyle = ColumnHeaderStyle.Nonclickable;
        BorderStyle = BorderStyle.None;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        Dock = DockStyle.Fill;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Theme.UseExplorerTheme(this);
    }
}

/// <summary>The vault as a tree, drawn as File Explorer's is.</summary>
internal sealed class ThemedTree : TreeView
{
    private const int TVM_SETEXTENDEDSTYLE = 0x1100 + 44;
    private const int TVS_EX_DOUBLEBUFFER = 0x0004;

    public ThemedTree()
    {
        BorderStyle = BorderStyle.None;
        ShowLines = false;
        FullRowSelect = true;
        // Without themes, hot tracking underlines names like links.
        HotTracking = Application.RenderWithVisualStyles;
        HideSelection = false;
        ShowNodeToolTips = true;
        BackColor = Theme.Surface;
        ForeColor = Theme.Text;
        Dock = DockStyle.Fill;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Theme.UseExplorerTheme(this);
        SendMessage(Handle, TVM_SETEXTENDEDSTYLE, (IntPtr)TVS_EX_DOUBLEBUFFER, (IntPtr)TVS_EX_DOUBLEBUFFER); // no flicker
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
}

/// <summary>
/// The line under the pane's header: a plain border, with a bar running along it while Vault is busy.
/// </summary>
internal sealed class ActivityBar : Control
{
    private readonly Timer _timer = new Timer { Interval = 30 };
    private float _phase;

    public ActivityBar()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        Dock = DockStyle.Top;
        Height = 2;
        _timer.Tick += (_, _) =>
        {
            _phase = (_phase + 0.015f) % 1.3f;
            Invalidate();
        };
    }

    public bool Running
    {
        get => _timer.Enabled;
        set
        {
            _timer.Enabled = value;
            _phase = 0;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Theme.Border);
        if (Running)
        {
            // A third of the width, sliding in from the left and out to the right.
            using var bar = new SolidBrush(Theme.Accent);
            e.Graphics.FillRectangle(bar, (_phase - 0.3f) * Width, 0, Width * 0.3f, Height);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
        }
        base.Dispose(disposing);
    }
}
