namespace Vault.Client;

/// <summary>What a vault:// link asks SolidWorks to do.</summary>
public enum LinkAction
{
    /// <summary>vault://open: open a vault file, after getting its latest version and the parts it uses.</summary>
    Open,

    /// <summary>vault://new: start a new part, assembly, or drawing (of a part or assembly) at a vault path.</summary>
    New,

    /// <summary>vault://connect: set SolidWorks up for a vault, signing in to its server if it isn't yet.</summary>
    Connect,
}

/// <summary>A vault:// link, checked: see <see cref="OpenLink.Parse"/>.</summary>
public sealed class LinkRequest
{
    internal LinkRequest(LinkAction action, Uri server, string vaultPath, string? model)
    {
        Action = action;
        Server = server;
        VaultPath = vaultPath;
        Model = model;
    }

    public LinkAction Action { get; }

    public Uri Server { get; }

    /// <summary>The file to open or start; "" for <see cref="LinkAction.Connect"/>.</summary>
    public string VaultPath { get; }

    /// <summary>For a new drawing: the vault path of the part or assembly it shows.</summary>
    public string? Model { get; }
}

/// <summary>
/// Links that SolidWorks follows, like
/// vault://open?server=https%3A%2F%2Fyjsp.example.org&amp;path=Structures%2FFin.SLDPRT (open a file),
/// vault://new?server=...&amp;path=Structures%2FFin.SLDDRW&amp;model=Structures%2FFin.SLDPRT (start a drawing
/// of a part), or vault://connect?server=... (sign in to that vault). The web app makes them; on Windows the
/// add-in's installer registers vault-open.exe to follow them.
/// </summary>
public static class OpenLink
{
    public const string Scheme = "vault";

    /// <summary>
    /// The scheme before 0.4.0, when the add-in was CVC's. The web app makes these until every laptop has an add-in
    /// that follows vault:// (docs/design.md, "Names from before YJSP"), so they're followed the same.
    /// </summary>
    public const string OldScheme = "cvc";
    private static readonly string[] NewKinds = { ".sldprt", ".sldasm", ".slddrw" };
    private static readonly string[] Models = { ".sldprt", ".sldasm" };

    public static string For(Uri server, string vaultPath) => Link("open", server, vaultPath, null);

    /// <summary>A link that starts a new part or assembly at vaultPath, or there a drawing of model.</summary>
    public static string ForNew(Uri server, string vaultPath, string? model = null) => Link("new", server, vaultPath, model);

    /// <summary>A link that sets SolidWorks up for the vault at server.</summary>
    public static string ForConnect(Uri server) => Scheme + "://connect?server=" + ServerText(server);

    /// <summary>What a link asks for. Anything else is a WorkspaceException, or a VaultPathException for a bad path.</summary>
    public static LinkRequest Parse(string link)
    {
        if (!Uri.TryCreate(link.Trim(), UriKind.Absolute, out var uri)
            || !(string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Scheme, OldScheme, StringComparison.OrdinalIgnoreCase))
            || uri.AbsolutePath.Trim('/').Length > 0)
        {
            throw new WorkspaceException("That isn't a Vault link: " + link);
        }
        var action = uri.Host.ToLowerInvariant() switch
        {
            "open" => LinkAction.Open,
            "new" => LinkAction.New,
            "connect" => LinkAction.Connect,
            _ => throw new WorkspaceException("That isn't a Vault link: " + link),
        };
        var query = BrowserSignIn.ParseQuery(uri.Query);
        if (!query.TryGetValue("server", out var serverText)
            || !Uri.TryCreate(serverText, UriKind.Absolute, out var server)
            || (server.Scheme != Uri.UriSchemeHttps && server.Scheme != Uri.UriSchemeHttp))
        {
            throw new WorkspaceException("The Vault link doesn't say which server it's from: " + link);
        }
        if (action == LinkAction.Connect)
        {
            return new LinkRequest(action, server, "", null);
        }
        var path = VaultPathIn(query, "path");
        if (path == null)
        {
            throw new WorkspaceException("The Vault link doesn't say which file: " + link);
        }
        string? model = null;
        if (action == LinkAction.New)
        {
            var kind = Path.GetExtension(path).ToLowerInvariant();
            if (!NewKinds.Contains(kind))
            {
                throw new WorkspaceException($"Vault starts new parts, assemblies, and drawings, not {Path.GetFileName(path)}");
            }
            model = VaultPathIn(query, "model");
            if (kind == ".slddrw" && (model == null || !Models.Contains(Path.GetExtension(model).ToLowerInvariant())))
            {
                throw new WorkspaceException("A new drawing needs the part or assembly it shows: " + link);
            }
            if (kind != ".slddrw")
            {
                model = null;
            }
        }
        return new LinkRequest(action, server, path, model);
    }

    private static string? VaultPathIn(Dictionary<string, string> query, string name)
    {
        var names = VaultPaths.Split(query.TryGetValue(name, out var path) ? path : "");
        return names.Count == 0 ? null : string.Join("/", names);
    }

    private static string Link(string action, Uri server, string vaultPath, string? model) =>
        Scheme + "://" + action + "?server=" + ServerText(server)
        + "&path=" + Uri.EscapeDataString(vaultPath)
        + (model == null ? "" : "&model=" + Uri.EscapeDataString(model));

    private static string ServerText(Uri server) =>
        Uri.EscapeDataString(VaultApi.WithTrailingSlash(server).AbsoluteUri.TrimEnd('/'));
}
