using System.IO.Compression;
using System.Text;
using System.Text.Json;

namespace Vault.Client;

/// <summary>
/// A part's shape for Caliper, the web app's 3D viewer: its bodies' triangles, in faces, in Caliper's mesh format
/// (server/src/yjsp_server/vault/caliper.py has the whole of it). Made face by face from what SolidWorks gives for each
/// (IFace2.GetTessTriangles: nine floats a triangle, in meters); kept in millimeters, each face's corners once.
/// </summary>
public sealed class CaliperMesh
{
    private const string Magic = "CMSH";
    private const uint Format = 1;

    private readonly List<float> _positions = new List<float>();
    private readonly List<uint> _indices = new List<uint>();
    private readonly List<Body> _bodies = new List<Body>();

    public int Vertices => _positions.Count / 3;

    public int Triangles => _indices.Count / 3;

    /// <summary>Start a body: the faces added next are its. Solid: a closed solid, which a section fills where it cuts.</summary>
    public void AddBody(string name, bool solid, CaliperColor? color)
    {
        _bodies.Add(new Body(name, solid, color ?? CaliperColor.Default));
    }

    /// <summary>
    /// Add a face to the body last started: its triangles as SolidWorks gives them (three corners each, x, y, z, in
    /// meters), in its own color or (null) its body's. A face without triangles adds nothing.
    /// </summary>
    public void AddFace(float[]? triangles, CaliperColor? color = null)
    {
        if (_bodies.Count == 0)
        {
            throw new InvalidOperationException("Add a body before its faces");
        }
        if (triangles == null || triangles.Length < 9)
        {
            return;
        }
        var first = Triangles;
        // A corner several triangles share is one vertex: the same floats are the same point.
        var corners = new Dictionary<(float, float, float), uint>();
        var whole = triangles.Length / 9 * 9; // a last triangle cut short isn't one
        for (var i = 0; i < whole; i += 3)
        {
            var corner = (triangles[i], triangles[i + 1], triangles[i + 2]);
            if (!corners.TryGetValue(corner, out var index))
            {
                index = (uint)Vertices;
                corners[corner] = index;
                _positions.Add(corner.Item1 * 1000f);
                _positions.Add(corner.Item2 * 1000f);
                _positions.Add(corner.Item3 * 1000f);
            }
            _indices.Add(index);
        }
        if (Triangles > first)
        {
            _bodies[_bodies.Count - 1].Faces.Add(new Face(first, Triangles - first, color));
        }
    }

    /// <summary>The mesh in Caliper's format, gzip-compressed, as the server keeps it.</summary>
    public byte[] ToArray()
    {
        var header = Header();
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        using (var writer = new BinaryWriter(gzip, Encoding.UTF8, leaveOpen: true))
        {
            writer.Write(Encoding.ASCII.GetBytes(Magic));
            writer.Write(Format);
            writer.Write((uint)header.Length);
            writer.Write(header);
            // BinaryWriter writes little-endian, as the format is.
            foreach (var value in _positions)
            {
                writer.Write(value);
            }
            foreach (var value in _indices)
            {
                writer.Write(value);
            }
        }
        return output.ToArray();
    }

    // The header: JSON, padded with spaces to a multiple of four bytes, so the arrays after it are aligned.
    private byte[] Header()
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteNumber("vertices", Vertices);
            json.WriteNumber("triangles", Triangles);
            json.WriteStartArray("bodies");
            foreach (var body in _bodies)
            {
                json.WriteStartObject();
                json.WriteString("name", body.Name);
                json.WriteBoolean("solid", body.Solid);
                WriteRgb(json, body.Color);
                json.WriteNumber("opacity", body.Color.Opacity);
                json.WriteStartArray("faces");
                foreach (var face in body.Faces)
                {
                    json.WriteStartObject();
                    json.WriteNumber("first", face.First);
                    json.WriteNumber("count", face.Count);
                    if (face.Color is { } color)
                    {
                        WriteRgb(json, color);
                    }
                    json.WriteEndObject();
                }
                json.WriteEndArray();
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        while (buffer.Length % 4 != 0)
        {
            buffer.WriteByte((byte)' ');
        }
        return buffer.ToArray();
    }

    private static void WriteRgb(Utf8JsonWriter json, CaliperColor color)
    {
        json.WriteStartArray("color");
        json.WriteNumberValue(color.Red);
        json.WriteNumberValue(color.Green);
        json.WriteNumberValue(color.Blue);
        json.WriteEndArray();
    }

    private sealed class Body
    {
        public Body(string name, bool solid, CaliperColor color) => (Name, Solid, Color) = (name, solid, color);

        public string Name { get; }

        public bool Solid { get; }

        public CaliperColor Color { get; }

        public List<Face> Faces { get; } = new List<Face>();
    }

    private sealed class Face
    {
        public Face(int first, int count, CaliperColor? color) => (First, Count, Color) = (first, count, color);

        public int First { get; }

        public int Count { get; }

        public CaliperColor? Color { get; }
    }
}

/// <summary>A color as Caliper shows it: red, green, and blue from 0 to 1, and how opaque.</summary>
public sealed class CaliperColor
{
    /// <summary>SolidWorks' blue-gray, for what has no color of its own.</summary>
    public static readonly CaliperColor Default = new CaliperColor(0.79, 0.82, 0.93);

    public CaliperColor(double red, double green, double blue, double opacity = 1)
    {
        Red = Clamp(red);
        Green = Clamp(green);
        Blue = Clamp(blue);
        Opacity = Clamp(opacity);
    }

    public double Red { get; }

    public double Green { get; }

    public double Blue { get; }

    public double Opacity { get; }

    /// <summary>
    /// A color from SolidWorks' material property values (MaterialPropertyValues: red, green, blue, ambient,
    /// diffuse, specular, shininess, transparency, emission); null if there are none.
    /// </summary>
    public static CaliperColor? FromSolidWorks(double[]? values) =>
        values == null || values.Length < 3
            ? null
            : new CaliperColor(values[0], values[1], values[2], values.Length > 7 ? 1 - values[7] : 1);

    private static double Clamp(double value) => double.IsNaN(value) ? 0 : Math.Max(0, Math.Min(1, value));
}
