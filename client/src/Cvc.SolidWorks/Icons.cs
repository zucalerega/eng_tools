using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Linq;

namespace Cvc.SolidWorks;

/// <summary>Task pane tab icons, drawn at startup (so the repository holds no image files).</summary>
internal static class Icons
{
    // The sizes SolidWorks asks for in CreateTaskpaneView3, smallest first.
    private static readonly int[] Sizes = { 20, 32, 40, 64, 96, 128 };

    public static string[] Write()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CVC", "icons");
        Directory.CreateDirectory(folder);
        return Sizes.Select(size => Draw(size, Path.Combine(folder, $"cvc-{size}.png"))).ToArray();
    }

    private static string Draw(int size, string path)
    {
        using (var bitmap = new Bitmap(size, size))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            using (var fill = new SolidBrush(Color.FromArgb(31, 111, 235)))
            using (var font = new Font("Segoe UI", size * (size <= 32 ? 0.55f : 0.3f), FontStyle.Bold, GraphicsUnit.Pixel))
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                graphics.Clear(Color.Transparent);
                var margin = Math.Max(1, size / 16);
                graphics.FillRectangle(fill, margin, margin, size - 2 * margin, size - 2 * margin);
                graphics.DrawString(size <= 32 ? "C" : "CVC", font, Brushes.White, new RectangleF(0, 0, size, size), format);
            }
            bitmap.Save(path, ImageFormat.Png);
        }
        return path;
    }
}
