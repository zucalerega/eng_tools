using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using Vault.Client;

namespace Vault.SolidWorks;

/// <summary>
/// What Caliper's 3D models need from SolidWorks: an open part's or assembly's configuration and units; an assembly's
/// components, where each is, and which are hidden; and the triangles SolidWorks draws each visible body's faces with.
/// Which models to make, and saving them, is Vault.Client's (CaliperModels). Call only on SolidWorks' main thread.
/// </summary>
internal sealed partial class SolidWorksHost
{
    /// <summary>An open part or assembly, read for its 3D models; null if it isn't open, or isn't one.</summary>
    public CaliperDocument? ReadForCaliper(string path)
    {
        var document = OpenDocument(path);
        if (document is not (PartDoc or AssemblyDoc) || document.GetActiveConfiguration() is not Configuration configuration)
        {
            return null;
        }
        var read = new CaliperDocument(path, configuration.Name, UnitsOf(document) ?? "mm", document);
        if (document is AssemblyDoc && configuration.GetRootComponent3(true) is Component2 root)
        {
            read.Components.AddRange(ComponentsOf(root, read));
        }
        return read;
    }

    /// <summary>
    /// Make the models a plan says to: of the document, of the parts it uses, and of its rigid sub-assemblies, each
    /// from what SolidWorks has open. A part with unsaved changes, or loaded lightweight (so its bodies aren't), isn't
    /// made, and says why.
    /// </summary>
    public CaliperMade MakeCaliperModels(CaliperDocument read, CaliperPlan plan)
    {
        var made = new CaliperMade();
        var name = Path.GetFileName(read.Path);
        if (read.Document.GetSaveFlag())
        {
            made.Problems.Add($"{name} has changes that aren't saved, so its 3D view wasn't made. Save it and check it in.");
            return made;
        }
        if (read.Document is PartDoc part && plan.Needs(read.Path, read.Configuration))
        {
            made.Parts.Add(new CaliperPart(read.Path, read.Configuration, read.Units, MeshOf(BodiesOf(part), read.Document)));
        }
        foreach (var used in read.Parts.Values)
        {
            if (plan.Needs(used.Path, used.Configuration) && PartMesh(used.Component, made.Problems) is { } mesh)
            {
                made.Parts.Add(new CaliperPart(used.Path, used.Configuration, UnitsOf(used.Component.GetModelDoc2() as ModelDoc2) ?? read.Units, mesh));
            }
        }
        var whole = read.Document is AssemblyDoc && plan.Needs(read.Path, read.Configuration);
        // A flexible sub-assembly's parts are where this assembly moved them, not where its own file has them.
        var subs = read.SubAssemblies.Values
            .Where(sub => plan.Needs(sub.Path, sub.Configuration) && sub.Component.Solving == (int)swComponentSolvingOption_e.swComponentRigidSolving)
            .ToList();
        if (whole || subs.Count > 0)
        {
            // Virtual parts have no files: the models of the assemblies they're in carry their shapes.
            foreach (var (component, solidWorks) in read.Virtual)
            {
                component.Mesh = PartMesh(solidWorks, made.Problems);
            }
        }
        if (whole)
        {
            made.Assemblies.Add(new CaliperAssembly(read.Path, read.Configuration, read.Units, read.Components));
        }
        foreach (var sub in subs)
        {
            var units = UnitsOf(sub.Component.GetModelDoc2() as ModelDoc2) ?? read.Units;
            made.Assemblies.Add(new CaliperAssembly(sub.Path, sub.Configuration, units, InSubAssembly(sub.Placed.Transform, sub.Placed.Children)));
        }
        return made;
    }

    // An assembly's components, at every level, as Caliper keeps them; and, in read, the parts and sub-assemblies they
    // are (each file and configuration once) and the virtual parts among them.
    private static List<CaliperComponent> ComponentsOf(Component2 parent, CaliperDocument read)
    {
        var components = new List<CaliperComponent>();
        if (parent.GetChildren() is not object[] children)
        {
            return components;
        }
        foreach (var child in children.OfType<Component2>())
        {
            // Suppressed: not in the assembly as it is. An envelope: a reference SolidWorks shows, not part of it. No
            // file, and not virtual: one SolidWorks couldn't find, which shows nothing.
            var path = child.GetPathName() ?? "";
            if (child.IsSuppressed() || child.IsEnvelope() || (path.Length == 0 && !child.IsVirtual))
            {
                continue;
            }
            var component = new CaliperComponent
            {
                Name = (child.Name2 ?? "").Substring((child.Name2 ?? "").LastIndexOf('/') + 1),
                LocalPath = child.IsVirtual ? null : path,
                Configuration = child.ReferencedConfiguration ?? "",
                Transform = child.Transform2 is MathTransform transform && transform.ArrayData is double[] data
                    ? CaliperTransforms.FromSolidWorks(data)
                    : CaliperTransforms.Identity,
                Hidden = child.IsHidden(true),
                Color = child.HasMaterialPropertyValues() ? CaliperColor.FromSolidWorks(child.MaterialPropertyValues as double[]) : null,
            };
            component.Children.AddRange(ComponentsOf(child, read));
            var key = (path.ToUpperInvariant(), component.Configuration);
            if (child.IsVirtual)
            {
                if (component.Children.Count == 0)
                {
                    read.Virtual.Add((component, child));
                }
            }
            else if (component.Children.Count > 0)
            {
                if (!read.SubAssemblies.ContainsKey(key))
                {
                    read.SubAssemblies[key] = new UsedFile(path, component.Configuration, child, component);
                }
            }
            else if (!read.Parts.ContainsKey(key))
            {
                read.Parts[key] = new UsedFile(path, component.Configuration, child, component);
            }
            components.Add(component);
        }
        return components;
    }

    // A sub-assembly's own components: where they are relative to it, not to the top assembly.
    private static List<CaliperComponent> InSubAssembly(double[] parent, List<CaliperComponent> components) =>
        components.Select(component =>
        {
            var moved = new CaliperComponent
            {
                Name = component.Name,
                LocalPath = component.LocalPath,
                Configuration = component.Configuration,
                Transform = CaliperTransforms.Relative(parent, component.Transform),
                Hidden = component.Hidden,
                Color = component.Color,
                Mesh = component.Mesh,
            };
            moved.Children.AddRange(InSubAssembly(parent, component.Children));
            return moved;
        }).ToList();

    // A part's mesh from a component of it: its bodies there are in the part's own coordinates, in the configuration
    // the component uses. Null (and why) if SolidWorks hasn't its bodies or has changes to them.
    private static CaliperMesh? PartMesh(Component2 component, List<string> problems)
    {
        var name = Path.GetFileName(component.GetPathName());
        var part = component.GetModelDoc2() as ModelDoc2;
        if (part?.GetSaveFlag() == true)
        {
            problems.Add($"{name} has changes that aren't saved, so its 3D view wasn't made.");
            return null;
        }
        var mesh = MeshOf(BodiesOf(component), part);
        if (mesh.Triangles == 0)
        {
            var lightweight = component.GetSuppression2() is (int)swComponentSuppressionState_e.swComponentLightweight
                or (int)swComponentSuppressionState_e.swComponentFullyLightweight;
            problems.Add(lightweight
                ? $"{name} is loaded lightweight, so SolidWorks hasn't its shape: right-click the assembly, choose Set Lightweight to Resolved, then click Make 3D view."
                : $"SolidWorks shows nothing of {name}, so it has no 3D view.");
            return null;
        }
        return mesh;
    }

    private static IEnumerable<(Body2 Body, bool Solid)> BodiesOf(PartDoc part) =>
        Bodies(part.GetBodies2((int)swBodyType_e.swSolidBody, true), true)
            .Concat(Bodies(part.GetBodies2((int)swBodyType_e.swSheetBody, true), false));

    private static IEnumerable<(Body2 Body, bool Solid)> BodiesOf(Component2 component) =>
        Bodies(component.GetBodies3((int)swBodyType_e.swSolidBody, out _), true)
            .Concat(Bodies(component.GetBodies3((int)swBodyType_e.swSheetBody, out _), false));

    private static IEnumerable<(Body2 Body, bool Solid)> Bodies(object? bodies, bool solid) =>
        bodies is object[] all ? all.OfType<Body2>().Where(body => body.Visible).Select(body => (body, solid)) : Enumerable.Empty<(Body2, bool)>();

    /// <summary>
    /// What SolidWorks draws of these bodies (its display tessellation, IFace2.GetTessTriangles), face by face, in the
    /// colors it shows them in: a face's own, else its feature's, else its body's, else the part's.
    /// </summary>
    private static CaliperMesh MeshOf(IEnumerable<(Body2 Body, bool Solid)> bodies, ModelDoc2? part)
    {
        var mesh = new CaliperMesh();
        var partColor = CaliperColor.FromSolidWorks(part?.MaterialPropertyValues as double[]);
        foreach (var (body, solid) in bodies)
        {
            var bodyColor = body.HasMaterialPropertyValues() ? CaliperColor.FromSolidWorks(body.MaterialPropertyValues2 as double[]) : partColor;
            mesh.AddBody(body.Name ?? "", solid, bodyColor);
            if (body.GetFaces() is not object[] faces)
            {
                continue;
            }
            foreach (var face in faces.OfType<Face2>())
            {
                mesh.AddFace(face.GetTessTriangles(true) as float[], FaceColor(face));
            }
        }
        return mesh;
    }

    private static CaliperColor? FaceColor(Face2 face)
    {
        if (face.HasMaterialPropertyValues())
        {
            return CaliperColor.FromSolidWorks(face.MaterialPropertyValues as double[]);
        }
        return face.GetFeature() is Feature feature && feature.HasMaterialPropertyValues()
            ? CaliperColor.FromSolidWorks(feature.GetMaterialPropertyValues2((int)swInConfigurationOpts_e.swThisConfiguration, null) as double[])
            : null;
    }

    private static string? UnitsOf(ModelDoc2? document) =>
        document == null ? null : CaliperUnits.FromSolidWorks(document.GetUserPreferenceIntegerValue((int)swUserPreferenceIntegerValue_e.swUnitsLinear));
}

/// <summary>An open part or assembly, read for its 3D models (SolidWorksHost.ReadForCaliper).</summary>
internal sealed class CaliperDocument
{
    public CaliperDocument(string path, string configuration, string units, ModelDoc2 document)
    {
        (Path, Configuration, Units, Document) = (path, configuration, units, document);
    }

    public string Path { get; }

    public string Configuration { get; }

    public string Units { get; }

    public ModelDoc2 Document { get; }

    /// <summary>An assembly's components, at every level.</summary>
    public List<CaliperComponent> Components { get; } = new List<CaliperComponent>();

    /// <summary>The parts it uses, each file in each configuration once.</summary>
    public Dictionary<(string, string), UsedFile> Parts { get; } = new Dictionary<(string, string), UsedFile>();

    /// <summary>Its sub-assemblies, each file in each configuration once.</summary>
    public Dictionary<(string, string), UsedFile> SubAssemblies { get; } = new Dictionary<(string, string), UsedFile>();

    /// <summary>Its virtual parts, which have no files of their own: the assembly's model carries their meshes.</summary>
    public List<(CaliperComponent Component, Component2 SolidWorks)> Virtual { get; } = new List<(CaliperComponent, Component2)>();

    /// <summary>The models wanted: the document's own, and those of every file it uses, where they're missing.</summary>
    public IEnumerable<CaliperWant> Wants() =>
        new[] { new CaliperWant(Path, Configuration) }
            .Concat(Parts.Values.Concat(SubAssemblies.Values).Select(used => new CaliperWant(used.Path, used.Configuration)));
}

/// <summary>A file an assembly uses, in a configuration, and the first of its components that is it.</summary>
internal sealed class UsedFile
{
    public UsedFile(string path, string configuration, Component2 component, CaliperComponent placed)
    {
        (Path, Configuration, Component, Placed) = (path, configuration, component, placed);
    }

    public string Path { get; }

    public string Configuration { get; }

    public Component2 Component { get; }

    public CaliperComponent Placed { get; }
}

/// <summary>The models made, and what wasn't, and why.</summary>
internal sealed class CaliperMade
{
    public List<CaliperPart> Parts { get; } = new List<CaliperPart>();

    public List<CaliperAssembly> Assemblies { get; } = new List<CaliperAssembly>();

    public List<string> Problems { get; } = new List<string>();
}
