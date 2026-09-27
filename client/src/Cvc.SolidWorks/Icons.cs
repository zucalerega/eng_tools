using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace Cvc.SolidWorks;

/// <summary>
/// Task pane tab icons, drawn at startup (so the repository holds no image files): Vault's mark, a vault
/// door crossed by a gold orbit, on navy, as the web app draws it (VaultMark in web/src/components.tsx).
/// Vault-Setup.exe draws its window's icon with it too.
/// </summary>
internal static class Icons
{
    // The sizes SolidWorks asks for in CreateTaskpaneView3, smallest first.
    private static readonly int[] Sizes = { 20, 32, 40, 64, 96, 128 };
    public static readonly Color Navy = Color.FromArgb(11, 27, 51);
    public static readonly Color Gold = Color.FromArgb(224, 165, 0);

    // The door, in the mark's 64-unit square.
    private static readonly PointF[] Octagon =
    {
        new PointF(54.2f, 41.2f), new PointF(41.2f, 54.2f), new PointF(22.8f, 54.2f), new PointF(9.8f, 41.2f),
        new PointF(9.8f, 22.8f), new PointF(22.8f, 9.8f), new PointF(41.2f, 9.8f), new PointF(54.2f, 22.8f),
    };

    private static readonly PointF[] Knobs = { new PointF(32, 14.5f), new PointF(16.8f, 40.8f), new PointF(47.2f, 40.8f) };

    public static string[] Write()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CVC", "icons");
        Directory.CreateDirectory(folder);
        return Sizes.Select(size => Save(size, Path.Combine(folder, $"vault-{size}.png"))).ToArray();
    }

    private static string Save(int size, string path)
    {
        using (var bitmap = Draw(size))
        {
            bitmap.Save(path, ImageFormat.Png);
        }
        return path;
    }

    /// <summary>The mark, size pixels square.</summary>
    public static Bitmap Draw(int size)
    {
        var bitmap = new Bitmap(size, size);
        using (var graphics = Graphics.FromImage(bitmap))
        using (var navy = new SolidBrush(Navy))
        using (var gold = new SolidBrush(Gold))
        using (var white = new Pen(Color.White, 5) { LineJoin = LineJoin.Miter })
        using (var gap = new Pen(Navy, 2.5f))
        using (var background = RoundedSquare(64, 14))
        using (var orbit = Orbit())
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            graphics.ScaleTransform(size / 64f, size / 64f);
            graphics.FillPath(navy, background);
            graphics.DrawPolygon(white, Octagon);
            white.Width = 3;
            graphics.DrawEllipse(white, 19.5f, 19.5f, 25, 25);
            if (size >= 32)
            {
                // The wheel's spokes and knobs: too fine to see at the smallest size.
                foreach (var knob in Knobs)
                {
                    graphics.DrawLine(white, 32, 32, knob.X, knob.Y);
                    graphics.FillEllipse(Brushes.White, knob.X - 2.8f, knob.Y - 2.8f, 5.6f, 5.6f);
                }
            }
            graphics.FillEllipse(Brushes.White, 27.5f, 27.5f, 9, 9);
            graphics.DrawPath(gap, orbit); // a sliver of navy between the orbit and the door
            graphics.FillPath(gold, orbit);
        }
        return bitmap;
    }

    private static GraphicsPath RoundedSquare(float side, float radius)
    {
        var square = new GraphicsPath();
        var corner = radius * 2;
        square.AddArc(0, 0, corner, corner, 180, 90);
        square.AddArc(side - corner, 0, corner, corner, 270, 90);
        square.AddArc(side - corner, side - corner, corner, corner, 0, 90);
        square.AddArc(0, side - corner, corner, corner, 90, 90);
        square.CloseFigure();
        return square;
    }

    // A crescent from bottom left to top right: the web app's M4 57 Q42 52 60 5 Q36 45 4 57 Z, as cubic curves.
    private static GraphicsPath Orbit()
    {
        var orbit = new GraphicsPath();
        orbit.AddBezier(new PointF(4, 57), new PointF(29.33f, 53.67f), new PointF(48, 36.33f), new PointF(60, 5));
        orbit.AddBezier(new PointF(60, 5), new PointF(44, 31.67f), new PointF(25.33f, 49), new PointF(4, 57));
        orbit.CloseFigure();
        return orbit;
    }
}
