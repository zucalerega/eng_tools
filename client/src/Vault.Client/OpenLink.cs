using System.Globalization;
using System.Text.Json;

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
            || !string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase)
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
        // A server's address is where it is, and no more: a name before an @ would look like where it isn't.
        if (server.UserInfo.Length > 0 || server.Query.Length > 0 || server.Fragment.Length > 0)
        {
            throw new WorkspaceException("The Vault link's server isn't a Vault server's address: " + link);
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

    /// <summary>
    /// What to ask before SolidWorks signs in to the server a link names, or null when it can go ahead: when it's the
    /// server SolidWorks is set up for, which is the one the workspace in workspaceFolder is for, or without one,
    /// lastServer, the one it last signed in to. Any web page can make a link, and one for another server (or any, before
    /// SolidWorks is set up) could be for a server that isn't the team's, which would get your sign-in and hand you its
    /// files. So the question shows its address, and only you can say it's the team's.
    /// </summary>
    public static string? ConnectQuestion(Uri server, string workspaceFolder, Uri? lastServer)
    {
        var setUpFor = WorkspaceServer(workspaceFolder) ?? lastServer;
        if (setUpFor != null && SameServer(server, setUpFor))
        {
            return null;
        }
        var question = setUpFor == null
            ? $"Connect SolidWorks to the vault at\n\n{Address(server)}\n\n"
            : $"A link asks to connect SolidWorks to the vault at\n\n{Address(server)}\n\nbut SolidWorks is set up for the one at "
                + $"{Address(setUpFor)}. Connect it to this one instead? ";
        var plain = server.Scheme == Uri.UriSchemeHttp
            ? "\n\nIts address is http, not https, so what you send it isn't private: only a test server's should be."
            : "";
        return question + "Say Yes only if that's your team's Vault, the address you open it at in your browser: "
            + "SolidWorks signs in to it, and gets your files from it." + plain;
    }

    /// <summary>
    /// A server's address as it really is, to check by eye: its host in letters anyone can read (punycode for a name in
    /// other alphabets, whose letters can pass for Latin ones), with its port and path, and nothing else.
    /// </summary>
    public static string Address(Uri server)
    {
        var host = server.HostNameType == UriHostNameType.Dns ? server.IdnHost : server.Host;
        var port = server.IsDefaultPort ? "" : ":" + server.Port.ToString(CultureInfo.InvariantCulture);
        return server.Scheme + "://" + host + port + server.AbsolutePath.TrimEnd('/');
    }

    /// <summary>Whether two addresses are the same Vault server's, however they're written.</summary>
    public static bool SameServer(Uri a, Uri b) =>
        string.Equals(a.AbsoluteUri.TrimEnd('/'), b.AbsoluteUri.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);

    // The server of the workspace at or above folder; null if there's none, or it can't be read.
    private static Uri? WorkspaceServer(string folder)
    {
        try
        {
            return Workspace.FindRoot(folder) is { } root ? Workspace.ServerOf(root) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException
            or JsonException or UriFormatException or WorkspaceException)
        {
            return null;
        }
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
