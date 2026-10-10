using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Vault.SolidWorks;

/// <summary>What a file's status means for you, which sets its color wherever it shows.</summary>
internal enum Tone
{
    /// <summary>Nothing to do: here, and up to date.</summary>
    Neutral,

    /// <summary>In the vault, not on this computer.</summary>
    Muted,

    /// <summary>New here: not in the vault yet.</summary>
    Info,

    /// <summary>Yours: checked out to you, here.</summary>
    Good,

    /// <summary>Worth a look: out of date, changed, or checked out elsewhere.</summary>
    Attention,

    /// <summary>Needs sorting out: a conflict, or deleted in the vault.</summary>
    Problem,
}

/// <summary>
/// How Vault's windows look: white panels on a light gray, Vault's navy for the main action, and a color for each
/// <see cref="Tone"/>, as in the web app. Sizes are for a 100% (96 DPI) display: the windows scale them
/// (AutoScaleMode.Dpi), and what's drawn here scales with the size it's asked for. Vault-Setup.exe uses it too.
/// </summary>
internal static class Theme
{
    public const string FolderImage = "folder";
    public const string NoImage = "none";

    public static readonly Color Background = Color.FromArgb(246, 248, 250);
    public static readonly Color Surface = Color.White;
    public static readonly Color Text = Color.FromArgb(31, 35, 40);
    public static readonly Color Muted = Color.FromArgb(89, 99, 110);
    public static readonly Color Border = Color.FromArgb(208, 215, 222);
    public static readonly Color Hover = Color.FromArgb(234, 238, 242);
    public static readonly Color Pressed = Color.FromArgb(220, 225, 230);
    public static readonly Color Accent = Icons.Navy;
    public static readonly Color AccentHover = Color.FromArgb(30, 55, 95);
    public static readonly Color AccentPressed = Color.FromArgb(4, 12, 26);

    public static readonly Font Base = SystemFonts.MessageBoxFont;
    public static readonly Font Bold = new Font(Base, FontStyle.Bold);
    public static readonly Font Heading = new Font(Base.FontFamily, Base.SizeInPoints + 1.5f, FontStyle.Bold);
    public static readonly Font Title = new Font(Base.FontFamily, Base.SizeInPoints + 3f, FontStyle.Bold);
    public static readonly Font Caption = new Font(Base.FontFamily, Base.SizeInPoints - 0.75f, FontStyle.Bold);

    /// <summary>Windows' icon font (Segoe MDL2 Assets, in Windows 10 and 11), or null if it's missing.</summary>
    public static readonly Font? Glyphs = LoadGlyphs();

    /// <summary>Menus in these colors: white, with the lists' hover, and no gradients.</summary>
    public static readonly ToolStripRenderer MenuRenderer = new ToolStripProfessionalRenderer(new MenuColors()) { RoundedEdges = false };

    /// <summary>A tone's color, for text and dots.</summary>
    public static Color Ink(Tone tone) => tone switch
    {
        Tone.Good => Color.FromArgb(26, 127, 55),
        Tone.Attention => Color.FromArgb(154, 103, 0),
        Tone.Problem => Color.FromArgb(207, 34, 46),
        Tone.Info => Color.FromArgb(9, 105, 218),
        Tone.Muted => Muted,
        _ => Text,
    };

    /// <summary>A tone's light background, behind a badge.</summary>
    public static Color Tint(Tone tone) => tone switch
    {
        Tone.Good => Color.FromArgb(218, 251, 225),
        Tone.Attention => Color.FromArgb(255, 245, 205),
        Tone.Problem => Color.FromArgb(255, 235, 233),
        Tone.Info => Color.FromArgb(221, 244, 255),
        _ => Hover,
    };

    /// <summary>A rectangle with round corners of this radius.</summary>
    public static GraphicsPath Rounded(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var corner = Math.Max(1, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
        path.AddArc(bounds.X, bounds.Y, corner, corner, 180, 90);
        path.AddArc(bounds.Right - corner, bounds.Y, corner, corner, 270, 90);
        path.AddArc(bounds.Right - corner, bounds.Bottom - corner, corner, corner, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - corner, corner, corner, 90, 90);
        path.CloseFigure();
        return path;
    }

    /// <summary>
    /// Draw a list or tree as File Explorer does: a soft highlight for what's selected and under the mouse, and
    /// arrows to open folders. Only where Windows draws themed controls; elsewhere they stay as they were.
    /// </summary>
    public static void UseExplorerTheme(Control control)
    {
        if (!Application.RenderWithVisualStyles)
        {
            return;
        }
        try
        {
            SetWindowTheme(control.Handle, "Explorer", null);
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            // Not this Windows: the plain look works the same.
        }
    }

    /// <summary>
    /// The list's and tree's small pictures, size pixels square: a folder, nothing, and a dot for each tone (keyed by
    /// its name), filled for files here and hollow for files that aren't.
    /// </summary>
    public static ImageList StatusImages(int size)
    {
        var images = new ImageList { ColorDepth = ColorDepth.Depth32Bit, ImageSize = new Size(size, size) };
        images.Images.Add(NoImage, new Bitmap(size, size));
        images.Images.Add(FolderImage, Folder(size));
        foreach (Tone tone in Enum.GetValues(typeof(Tone)))
        {
            images.Images.Add(tone.ToString(), Dot(size, tone));
        }
        return images;
    }

    private static Bitmap Dot(int size, Tone tone)
    {
        var bitmap = new Bitmap(size, size);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var diameter = Math.Max(4f, size * 0.4f);
        var at = (size - diameter) / 2;
        if (tone == Tone.Muted)
        {
            var width = Math.Max(1f, size / 14f);
            using var ring = new Pen(Color.FromArgb(160, 170, 180), width);
            graphics.DrawEllipse(ring, at + (width / 2), at + (width / 2), diameter - width, diameter - width);
        }
        else
        {
            using var fill = new SolidBrush(tone == Tone.Neutral ? Color.FromArgb(150, 160, 170) : Ink(tone));
            graphics.FillEllipse(fill, at, at, diameter, diameter);
        }
        return bitmap;
    }

    // A folder in the yellow of File Explorer's, drawn on a 20-unit square.
    private static Bitmap Folder(int size)
    {
        var bitmap = new Bitmap(size, size);
        using var graphics = Graphics.FromImage(bitmap);
        using var back = new SolidBrush(Color.FromArgb(222, 164, 40));
        using var front = new SolidBrush(Color.FromArgb(247, 199, 76));
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.ScaleTransform(size / 20f, size / 20f);
        using (var tab = new GraphicsPath())
        {
            tab.AddLines(new[] { new PointF(2, 4.5f), new PointF(7.5f, 4.5f), new PointF(9.5f, 6.5f), new PointF(18, 6.5f), new PointF(18, 15.5f), new PointF(2, 15.5f) });
            tab.CloseFigure();
            graphics.FillPath(back, tab);
        }
        using (var body = new GraphicsPath())
        {
            body.AddRectangle(new RectangleF(2, 8, 16, 7.5f));
            graphics.FillPath(front, body);
        }
        return bitmap;
    }

    private static Font? LoadGlyphs()
    {
        using var fonts = new InstalledFontCollection();
        return fonts.Families.Any(f => f.Name == "Segoe MDL2 Assets") ? new Font("Segoe MDL2 Assets", Base.SizeInPoints + 1f) : null;
    }

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr window, string subAppName, string? subIdList);

    private sealed class MenuColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Surface;

        public override Color ImageMarginGradientBegin => Surface;

        public override Color ImageMarginGradientMiddle => Surface;

        public override Color ImageMarginGradientEnd => Surface;

        public override Color MenuBorder => Border;

        public override Color MenuItemBorder => Hover;

        public override Color MenuItemSelected => Hover;

        public override Color MenuItemSelectedGradientBegin => Hover;

        public override Color MenuItemSelectedGradientEnd => Hover;

        public override Color MenuItemPressedGradientBegin => Pressed;

        public override Color MenuItemPressedGradientEnd => Pressed;

        public override Color SeparatorDark => Border;

        public override Color SeparatorLight => Surface;
    }
}

/// <summary>
/// A flat button: navy for a window's main action (<see cref="Primary"/>), outlined for the rest, borderless when
/// <see cref="Quiet"/> (the pane's header), and gray while it can't be used.
/// </summary>
internal sealed class FlatButton : Button
{
    private bool _primary;
    private bool _quiet;

    public FlatButton(string text)
    {
        Text = text;
        FlatStyle = FlatStyle.Flat;
        UseVisualStyleBackColor = false;
        UseCompatibleTextRendering = false;
        // Sized by their text, at least as tall as a text box. GrowAndShrink keeps the window's DPI scaling from
        // leaving them enlarged, as GrowOnly (the default) would.
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(64, 28);
        Padding = new Padding(6, 0, 6, 0);
        Margin = new Padding(0, 0, 6, 6);
        Restyle();
    }

    public bool Primary
    {
        get => _primary;
        set
        {
            if (_primary != value)
            {
                _primary = value;
                Restyle();
            }
        }
    }

    public bool Quiet
    {
        get => _quiet;
        set
        {
            _quiet = value;
            Restyle();
        }
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Restyle();
    }

    private void Restyle()
    {
        var face = !Enabled ? (Quiet ? Color.Transparent : Theme.Hover) : Primary ? Theme.Accent : Quiet ? Color.Transparent : Theme.Surface;
        BackColor = face;
        ForeColor = !Enabled ? Theme.Muted : Primary ? Color.White : Theme.Text;
        FlatAppearance.BorderSize = Quiet ? 0 : 1;
        FlatAppearance.BorderColor = Primary && Enabled ? Theme.Accent : Theme.Border;
        FlatAppearance.MouseOverBackColor = Primary ? Theme.AccentHover : Theme.Hover;
        FlatAppearance.MouseDownBackColor = Primary ? Theme.AccentPressed : Theme.Pressed;
    }
}
