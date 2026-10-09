using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vault.Client.Tests;

/// <summary>
/// Caliper's 3D models, as the add-in makes them from what SolidWorks reads: the mesh format (which the server checks,
/// and the web app reads), SolidWorks' transforms, colors, and units, and which models to make and saving them.
/// </summary>
[Collection("server")]
public sealed class CaliperTests : IDisposable
{
    private readonly ServerFixture _server;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "vault-caliper-" + Guid.NewGuid().ToString("N"));
    private readonly string _folder = "Test-" + Guid.NewGuid().ToString("N").Substring(0, 8);
    private readonly List<Workspace> _workspaces = new List<Workspace>();

    public CaliperTests(ServerFixture server) => _server = server;

    public void Dispose()
    {
        _workspaces.ForEach(w => w.Dispose());
        TempFolders.Delete(_temp);
    }

    /// <summary>A square face as SolidWorks gives it: two triangles, nine floats each, in meters.</summary>
    private static float[] Square(float z) =>
    [
        0, 0, z, 0.01f, 0, z, 0.01f, 0.02f, z,
        0, 0, z, 0.01f, 0.02f, z, 0, 0.02f, z,
    ];

    /// <summary>What a mesh holds, read back as the server and the web app read it.</summary>
    private static (JsonNode Header, float[] Positions, uint[] Indices) Read(byte[] mesh)
    {
        using var gzip = new GZipStream(new MemoryStream(mesh), CompressionMode.Decompress);
        using var unpacked = new MemoryStream();
        gzip.CopyTo(unpacked);
        var data = unpacked.ToArray();
        Assert.Equal("CMSH", Encoding.ASCII.GetString(data, 0, 4));
        Assert.Equal(1u, BitConverter.ToUInt32(data, 4));
        var length = (int)BitConverter.ToUInt32(data, 8);
        Assert.Equal(0, length % 4);
        var header = JsonNode.Parse(Encoding.UTF8.GetString(data, 12, length))!;
        var vertices = header["vertices"]!.GetValue<int>();
        var triangles = header["triangles"]!.GetValue<int>();
        var positions = new float[3 * vertices];
        var indices = new uint[3 * triangles];
        Buffer.BlockCopy(data, 12 + length, positions, 0, 4 * positions.Length);
        Buffer.BlockCopy(data, 12 + length + (4 * positions.Length), indices, 0, 4 * indices.Length);
        Assert.Equal(data.Length, 12 + length + (4 * positions.Length) + (4 * indices.Length));
        return (header, positions, indices);
    }

    [Fact]
    public void MeshesKeepEachFaceCornerOnceInMillimeters()
    {
        var mesh = new CaliperMesh();
        mesh.AddBody("Boss-Extrude1", solid: true, color: null);
        mesh.AddFace(Square(0));
        mesh.AddFace(Square(0.005f), new CaliperColor(1, 0, 0));
        mesh.AddFace([1, 2, 3]); // less than a triangle: nothing
        mesh.AddBody("Surface-Knit1", solid: false, new CaliperColor(0, 0.5, 1, 0.25));
        mesh.AddFace(Square(0.01f));

        var (header, positions, indices) = Read(mesh.ToArray());
        Assert.Equal(12, header["vertices"]!.GetValue<int>()); // four corners a face, though six of each face's triangles' corners
        Assert.Equal(6, header["triangles"]!.GetValue<int>());
        var body = header["bodies"]![0]!;
        Assert.Equal(("Boss-Extrude1", true, 1.0), (body["name"]!.GetValue<string>(), body["solid"]!.GetValue<bool>(), body["opacity"]!.GetValue<double>()));
        Assert.Equal([0.79, 0.82, 0.93], body["color"]!.AsArray().Select(c => c!.GetValue<double>()));
        var faces = body["faces"]!.AsArray();
        Assert.Equal(2, faces.Count);
        Assert.Equal((2, 2), (faces[1]!["first"]!.GetValue<int>(), faces[1]!["count"]!.GetValue<int>()));
        Assert.Equal([1.0, 0, 0], faces[1]!["color"]!.AsArray().Select(c => c!.GetValue<double>()));
        Assert.Null(faces[0]!["color"]);
        var surface = header["bodies"]![1]!;
        Assert.Equal((false, 0.25), (surface["solid"]!.GetValue<bool>(), surface["opacity"]!.GetValue<double>()));
        Assert.Equal([10f, 20f, 0f], positions.Skip(6).Take(3)); // the third corner, in mm
        Assert.Equal([0u, 1, 2, 0, 2, 3], indices.Take(6));
        Assert.Equal(8u, indices[12]); // the surface's first corner
    }

    [Fact]
    public void SolidWorksTransformsColorsAndUnits()
    {
        // A quarter turn about Y, then 40 mm along X: SolidWorks keeps the rotation by columns, and meters.
        double[] data = [0, 0, -1, 0, 1, 0, 1, 0, 0, 0.04, 0, 0, 1, 0, 0, 0];
        var rows = CaliperTransforms.FromSolidWorks(data);
        Assert.Equal([0, 0, 1, 40, 0, 1, 0, 0, -1, 0, 0, 0], rows);
        // A point 10 mm along the part's X goes 10 mm down Z, then over by 40.
        double[] point = [10, 0, 0];
        var moved = Enumerable.Range(0, 3).Select(i => (rows[4 * i] * point[0]) + (rows[(4 * i) + 1] * point[1]) + (rows[(4 * i) + 2] * point[2]) + rows[(4 * i) + 3]);
        Assert.Equal([40, 0, -10], moved);

        // A fin 40 mm out in a fin can that's turned and 600 mm up the rocket: in the can, it's just 40 mm out.
        var can = CaliperTransforms.FromSolidWorks([0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0.6, 0, 1, 0, 0, 0]);
        double[] finInCan = [1, 0, 0, 40, 0, 1, 0, 0, 0, 0, 1, 0];
        double[] finInRocket = [0, 0, 1, 0, 0, 1, 0, 600, -1, 0, 0, -40]; // the can's turn, then the can's place
        Assert.Equal(finInCan, CaliperTransforms.Relative(can, finInRocket).Select(v => Math.Round(v, 9)));

        var color = CaliperColor.FromSolidWorks([1, 0.5, 0, 0.5, 0.5, 0.5, 0.3, 0.25, 0])!;
        Assert.Equal((1, 0.5, 0, 0.75), (color.Red, color.Green, color.Blue, color.Opacity));
        Assert.Null(CaliperColor.FromSolidWorks(null));
        Assert.Equal(["mm", "cm", "m", "in", "ft", "in", "mm"], new[] { 0, 1, 2, 3, 4, 5, 8 }.Select(CaliperUnits.FromSolidWorks));
    }

    [Fact]
    public async Task ModelsAreMadeOfVersionsThatHaveNoneYet()
    {
        var alice = await WorkspaceAsync("alice");
        var fin = Write(alice, "Fins/Fin.SLDPRT", "fin");
        var can = Write(alice, "Fins/Fin Can.SLDASM", "can");
        var draft = Write(alice, "Fins/Draft.SLDPRT", "a part not checked in");
        await alice.CheckinAsync([fin, can], "the fin can", referencesOf: p => p == can ? new[] { fin } : Array.Empty<string>());
        var models = new CaliperModels(alice);

        var plan = await models.PlanAsync([new CaliperWant(can, "Default"), new CaliperWant(fin, "Default"), new CaliperWant(fin, "Long"), new CaliperWant(draft, "Default")]);
        Assert.Equal(3, plan.Count);
        Assert.True(plan.Needs(fin.ToLowerInvariant(), "Long")); // paths as Windows compares them
        Assert.Contains(plan.Problems, p => p.Contains("Draft.SLDPRT isn't in the vault yet", StringComparison.Ordinal));

        var finMesh = new CaliperMesh();
        finMesh.AddBody("Fin", solid: true, color: null);
        finMesh.AddFace(Square(0));
        var bracket = new CaliperMesh();
        bracket.AddBody("Bracket", solid: true, new CaliperColor(0.2, 0.2, 0.2));
        bracket.AddFace(Square(0.003f));
        var turned = CaliperTransforms.FromSolidWorks([0, 0, -1, 0, 1, 0, 1, 0, 0, 0.04, 0, 0, 1, 0, 0, 0]);
        var components = new List<CaliperComponent>
        {
            new CaliperComponent { Name = "Fin-1", LocalPath = fin, Configuration = "Default" },
            new CaliperComponent { Name = "Fin-2", LocalPath = fin, Configuration = "Default", Transform = turned, Hidden = true },
            new CaliperComponent { Name = "Bracket^Fin Can", Mesh = bracket, Color = new CaliperColor(1, 0, 0) },
            new CaliperComponent { Name = "Draft-1", LocalPath = draft, Configuration = "Default" },
        };
        var saved = await models.SaveAsync(
            plan,
            [new CaliperPart(fin, "Default", "in", finMesh)],
            [new CaliperAssembly(can, "Default", "mm", components)]);
        Assert.Equal(2, saved.Made);
        Assert.Contains(saved.Problems, p => p.StartsWith("Draft-1 is left out of Fin Can.SLDASM's 3D model", StringComparison.Ordinal));

        // As the web app sees them.
        var ids = (await alice.StatusAsync([fin, can])).ToDictionary(s => Path.GetFileName(s.LocalPath), s => s.FileId!.Value);
        using var http = _server.Http(await _server.MemberTokenAsync("alice@rocketry.test"));
        var assembly = JsonNode.Parse(await http.GetStringAsync($"api/files/{ids["Fin Can.SLDASM"]}/caliper/assembly?version=1&configuration=Default"))!;
        var placed = assembly["components"]!.AsArray();
        Assert.Equal(["Fin-1", "Fin-2", "Bracket^Fin Can"], placed.Select(c => c!["name"]!.GetValue<string>()));
        Assert.Equal((ids["Fin.SLDPRT"], 1, true), (placed[0]!["file_id"]!.GetValue<long>(), placed[0]!["version"]!.GetValue<int>(), placed[0]!["model"]!.GetValue<bool>()));
        Assert.Equal(turned, placed[1]!["transform"]!.AsArray().Select(v => v!.GetValue<double>()));
        Assert.True(placed[1]!["hidden"]!.GetValue<bool>());
        Assert.Equal([1.0, 0, 0], placed[2]!["color"]!.AsArray().Select(v => v!.GetValue<double>()));
        var mesh = await http.GetByteArrayAsync($"api/files/{ids["Fin.SLDPRT"]}/caliper/mesh?version=1&configuration=Default");
        Assert.Equal(finMesh.ToArray(), mesh); // sent as it's kept: gzip, which a browser unpacks on the way
        var finModel = Assert.Single(await alice.Api.CaliperModelsAsync(ids["Fin.SLDPRT"]));
        Assert.Equal(("part", "in", "Default"), (finModel.Kind, finModel.Units, finModel.Configuration));

        // Made, they aren't asked for again; the Long configuration still is.
        var again = await models.PlanAsync([new CaliperWant(can, "Default"), new CaliperWant(fin, "Default"), new CaliperWant(fin, "Long")]);
        Assert.Equal(1, again.Count);
        Assert.True(again.Needs(fin, "Long"));
        Assert.True((await models.PlanAsync([new CaliperWant(fin, "Default", always: true)])).Needs(fin, "Default"));
    }

    [Fact]
    public async Task FilesChangedHereHaveNoModelUntilTheyreCheckedIn()
    {
        var bob = await WorkspaceAsync("bob");
        var tank = Write(bob, "Tank.SLDPRT", "tank v1");
        await bob.CheckinAsync([tank], "the tank");
        await bob.CheckoutAsync([tank]);
        File.WriteAllText(tank, "tank v2, not checked in");

        var plan = await new CaliperModels(bob).PlanAsync([new CaliperWant(tank, "Default")]);
        Assert.Equal(0, plan.Count);
        Assert.Equal(["Tank.SLDPRT is changed here and not checked in: it gets a 3D model when it is."], plan.Problems);
    }

    private async Task<Workspace> WorkspaceAsync(string person)
    {
        var token = await _server.MemberTokenAsync($"{person}@rocketry.test");
        var workspace = Workspace.Create(Path.Combine(_temp, person), _server.Url, token, host: person.ToUpperInvariant() + "-PC");
        _workspaces.Add(workspace);
        return workspace;
    }

    private string Write(Workspace workspace, string relative, string contents)
    {
        var path = Path.Combine(workspace.Root, _folder, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, contents);
        return path;
    }
}
