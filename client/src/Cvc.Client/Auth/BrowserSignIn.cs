using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Cvc.Client;

/// <summary>
/// Signs the CLI or add-in in through the browser, like OAuth for native apps (RFC 8252):
/// listen on 127.0.0.1, open the server's /auth/client page with a PKCE challenge, get a
/// one-time code back on the callback, and trade it (with the PKCE verifier) for a token.
/// </summary>
public static class BrowserSignIn
{
    public static async Task<IssuedToken> SignInAsync(
        Uri server, string clientName, Action<Uri> openBrowser, TimeSpan timeout, CancellationToken ct = default)
    {
        var verifier = Base64Url(RandomBytes(32));
        var state = Base64Url(RandomBytes(16));
        // A raw TcpListener rather than HttpListener: no URL reservation or admin rights needed on Windows.
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port.ToString(CultureInfo.InvariantCulture);
            var query = "auth/client?port=" + port + "&state=" + state + "&challenge=" + PkceChallenge(verifier)
                + "&name=" + Uri.EscapeDataString(clientName);
            openBrowser(new Uri(CvcApi.WithTrailingSlash(server), query));

            var callback = await WaitForCallbackAsync(listener, timeout, ct).ConfigureAwait(false);
            if (Value(callback, "state") != state)
            {
                throw new CvcApiException(403, "state_mismatch", "The sign-in response didn't match this request; try again");
            }
            if (Value(callback, "error") != null)
            {
                throw new CvcApiException(403, "access_denied", "Sign-in was cancelled in the browser");
            }
            var code = Value(callback, "code")
                ?? throw new CvcApiException(403, "no_code", "The browser didn't send a sign-in code; try again");
            using var api = new CvcApi(server);
            return await api.RedeemSignInCodeAsync(code, verifier, ct).ConfigureAwait(false);
        }
        finally
        {
            listener.Stop();
        }
    }

    internal static string PkceChallenge(string verifier)
    {
        using var sha = SHA256.Create();
        return Base64Url(sha.ComputeHash(Encoding.ASCII.GetBytes(verifier)));
    }

    internal static Dictionary<string, string> ParseQuery(string target)
    {
        var query = new Dictionary<string, string>(StringComparer.Ordinal);
        var start = target.IndexOf('?');
        if (start < 0)
        {
            return query;
        }
        foreach (var pair in target.Substring(start + 1).Split('&'))
        {
            if (pair.Length == 0)
            {
                continue;
            }
            var equals = pair.IndexOf('=');
            var key = Decode(equals < 0 ? pair : pair.Substring(0, equals));
            query[key] = equals < 0 ? "" : Decode(pair.Substring(equals + 1));
        }
        return query;
    }

    private static async Task<Dictionary<string, string>> WaitForCallbackAsync(
        TcpListener listener, TimeSpan timeout, CancellationToken ct)
    {
        var result = new TaskCompletionSource<Dictionary<string, string>>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = Task.Run(async () =>
        {
            while (!result.Task.IsCompleted)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception e) when (e is ObjectDisposedException or SocketException or InvalidOperationException)
                {
                    return; // the listener was stopped
                }
                // One task per connection: browsers open idle "preconnect" sockets that would block a single loop.
                _ = Task.Run(() => Answer(client, result));
            }
        });

        using var giveUp = new CancellationTokenSource();
        using (ct.Register(() => result.TrySetCanceled()))
        {
            var finished = await Task.WhenAny(result.Task, Task.Delay(timeout, giveUp.Token)).ConfigureAwait(false);
            giveUp.Cancel();
            if (finished != result.Task)
            {
                throw new TimeoutException("Timed out waiting for sign-in in the browser");
            }
            return await result.Task.ConfigureAwait(false);
        }
    }

    private static void Answer(TcpClient client, TaskCompletionSource<Dictionary<string, string>> result)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 10_000;
                client.SendTimeout = 10_000;
                var stream = client.GetStream();
                var target = ReadRequestTarget(stream);
                if (target == null)
                {
                    return;
                }
                if (!target.StartsWith("/callback", StringComparison.Ordinal))
                {
                    Respond(stream, "404 Not Found", "<p>Not found.</p>");
                    return;
                }
                var query = ParseQuery(target);
                var signedIn = query.ContainsKey("code") && !query.ContainsKey("error");
                Respond(stream, "200 OK", signedIn
                    ? "<h1>Signed in to Vault</h1><p>You can close this tab.</p>"
                    : "<h1>Sign-in cancelled</h1><p>You can close this tab.</p>");
                result.TrySetResult(query);
            }
            catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
            {
                // A connection that went away or never sent a request.
            }
        }
    }

    // "GET /callback?code=... HTTP/1.1" -> "/callback?code=...", or null.
    private static string? ReadRequestTarget(NetworkStream stream)
    {
        var buffer = new byte[16 * 1024];
        var length = 0;
        while (length < buffer.Length)
        {
            var read = stream.Read(buffer, length, buffer.Length - length);
            if (read == 0)
            {
                break;
            }
            length += read;
            if (Encoding.ASCII.GetString(buffer, 0, length).IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0)
            {
                break;
            }
        }
        var head = Encoding.ASCII.GetString(buffer, 0, length);
        var lineEnd = head.IndexOf("\r\n", StringComparison.Ordinal);
        var parts = (lineEnd >= 0 ? head.Substring(0, lineEnd) : head).Split(' ');
        return parts.Length >= 2 && parts[0] == "GET" ? parts[1] : null;
    }

    private static void Respond(NetworkStream stream, string status, string body)
    {
        var html = Encoding.UTF8.GetBytes(
            "<!doctype html><meta charset=\"utf-8\"><title>Vault</title>"
            + "<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto\">" + body + "</body>");
        var head = Encoding.ASCII.GetBytes(
            "HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
            + html.Length.ToString(CultureInfo.InvariantCulture) + "\r\nConnection: close\r\n\r\n");
        stream.Write(head, 0, head.Length);
        stream.Write(html, 0, html.Length);
    }

    private static string? Value(Dictionary<string, string> query, string key) =>
        query.TryGetValue(key, out var value) ? value : null;

    private static string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static byte[] RandomBytes(int count)
    {
        var bytes = new byte[count];
        using var random = RandomNumberGenerator.Create();
        random.GetBytes(bytes);
        return bytes;
    }

    private static string Base64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
