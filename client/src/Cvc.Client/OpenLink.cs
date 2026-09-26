namespace Cvc.Client;

/// <summary>
/// Links that open a vault file in SolidWorks, like
/// cvc://open?server=https%3A%2F%2Fcvc.example.org&amp;path=Structures%2FFin.SLDPRT. The web app's
/// "Open in SolidWorks" makes them; on Windows the add-in's installer registers cvc-open.exe to
/// follow them.
/// </summary>
public static class OpenLink
{
    public const string Scheme = "cvc";

    public static string For(Uri server, string vaultPath) =>
        Scheme + "://open?server=" + Uri.EscapeDataString(CvcApi.WithTrailingSlash(server).AbsoluteUri.TrimEnd('/'))
        + "&path=" + Uri.EscapeDataString(vaultPath);

    /// <summary>The server and vault path a link names. Anything else is a WorkspaceException.</summary>
    public static (Uri Server, string VaultPath) Parse(string link)
    {
        if (!Uri.TryCreate(link.Trim(), UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.Host, "open", StringComparison.OrdinalIgnoreCase)
            || uri.AbsolutePath.Trim('/').Length > 0)
        {
            throw new WorkspaceException("That isn't a CVC link to a file: " + link);
        }
        var query = BrowserSignIn.ParseQuery(uri.Query);
        if (!query.TryGetValue("server", out var serverText)
            || !Uri.TryCreate(serverText, UriKind.Absolute, out var server)
            || (server.Scheme != Uri.UriSchemeHttps && server.Scheme != Uri.UriSchemeHttp))
        {
            throw new WorkspaceException("The CVC link doesn't say which server it's from: " + link);
        }
        var names = VaultPaths.Split(query.TryGetValue("path", out var path) ? path : "");
        if (names.Count == 0)
        {
            throw new WorkspaceException("The CVC link doesn't say which file to open: " + link);
        }
        return (server, string.Join("/", names));
    }
}
