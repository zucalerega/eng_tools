using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;

namespace Vault.Client.Tests;

/// <summary>
/// The real server (`uv run yjsp-server` in server/), with dev sign-in, on a free port,
/// with a throwaway vault in which everyone is an editor. Shared by the tests in the
/// "server" collection; each test works in its own vault folder.
/// </summary>
public sealed class ServerFixture : IAsyncLifetime
{
    public const string Chief = "chief@rocketry.test";

    private readonly string _data = Path.Combine(Path.GetTempPath(), "yjsp-server-" + Guid.NewGuid().ToString("N"));
    private readonly StringBuilder _log = new StringBuilder();
    private Process? _server;

    public Uri Url { get; private set; } = new Uri("http://127.0.0.1/");

    public string ChiefToken { get; private set; } = "";

    /// <summary>The server's YJSP_DOWNLOADS_DIR: what's put here is offered for download.</summary>
    public string DownloadsFolder => Path.Combine(_data, "downloads");

    public async Task InitializeAsync()
    {
        var port = FreePort();
        Url = new Uri($"http://127.0.0.1:{port}/");
        var start = new ProcessStartInfo("uv")
        {
            WorkingDirectory = FindServerFolder(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("run");
        start.ArgumentList.Add("--quiet");
        start.ArgumentList.Add("yjsp-server");
        start.Environment["YJSP_ENV"] = "development";
        start.Environment["YJSP_DEV_AUTH"] = "1";
        start.Environment["YJSP_BOOTSTRAP_ADMINS"] = Chief;
        start.Environment["YJSP_HOST"] = "127.0.0.1";
        start.Environment["YJSP_PORT"] = port.ToString(CultureInfo.InvariantCulture);
        start.Environment["YJSP_PUBLIC_URL"] = Url.AbsoluteUri.TrimEnd('/');
        start.Environment["YJSP_DATABASE_URL"] = "sqlite:///" + Path.Combine(_data, "yjsp.db");
        start.Environment["YJSP_VAULT_DIR"] = Path.Combine(_data, "vault");
        start.Environment["YJSP_YORG_DIR"] = Path.Combine(_data, "yorg");
        Directory.CreateDirectory(DownloadsFolder);
        start.Environment["YJSP_DOWNLOADS_DIR"] = DownloadsFolder;
        _server = Process.Start(start) ?? throw new InvalidOperationException("Couldn't start the server with uv");
        _server.OutputDataReceived += (_, e) => Log(e.Data);
        _server.ErrorDataReceived += (_, e) => Log(e.Data);
        _server.BeginOutputReadLine();
        _server.BeginErrorReadLine();
        await WaitUntilUpAsync();

        using var anonymous = new VaultApi(Url);
        ChiefToken = (await anonymous.DevTokenAsync(Chief)).Token;
        using var chief = Http(ChiefToken);
        var everyoneEdits = await chief.PutAsJsonAsync("api/grants", new { path = "", user_id = (long?)null, role = "editor" });
        everyoneEdits.EnsureSuccessStatusCode();
    }

    public Task DisposeAsync()
    {
        if (_server is { HasExited: false })
        {
            _server.Kill(entireProcessTree: true);
            _server.WaitForExit(10_000);
        }
        _server?.Dispose();
        TempFolders.Delete(_data);
        return Task.CompletedTask;
    }

    /// <summary>A token for an approved member (invited by the chief, then signed in).</summary>
    public async Task<string> MemberTokenAsync(string email)
    {
        using (var chief = Http(ChiefToken))
        {
            var local = email.Substring(0, email.IndexOf('@', StringComparison.Ordinal));
            var name = char.ToUpperInvariant(local[0]) + local.Substring(1);
            using var invite = await chief.PostAsJsonAsync("api/users", new { email, name });
            if (invite.StatusCode != HttpStatusCode.Conflict)
            {
                invite.EnsureSuccessStatusCode();
            }
        }
        using var anonymous = new VaultApi(Url);
        return (await anonymous.DevTokenAsync(email)).Token;
    }

    public HttpClient Http(string? token = null)
    {
        var http = new HttpClient { BaseAddress = Url };
        if (token != null)
        {
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        }
        return http;
    }

    private async Task WaitUntilUpAsync()
    {
        using var http = Http();
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            if (_server!.HasExited)
            {
                throw new InvalidOperationException("The server exited while starting:\n" + Output());
            }
            try
            {
                using var response = await http.GetAsync("healthz");
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (HttpRequestException)
            {
                // not listening yet
            }
            await Task.Delay(200);
        }
        throw new TimeoutException("The server didn't start within 90 s:\n" + Output());
    }

    private void Log(string? line)
    {
        if (line != null)
        {
            lock (_log)
            {
                _log.AppendLine(line);
            }
        }
    }

    private string Output()
    {
        lock (_log)
        {
            return _log.ToString();
        }
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string FindServerFolder()
    {
        for (var dir = AppContext.BaseDirectory; dir != null; dir = Path.GetDirectoryName(dir))
        {
            var server = Path.Combine(dir, "server");
            if (File.Exists(Path.Combine(server, "pyproject.toml")))
            {
                return server;
            }
        }
        throw new InvalidOperationException("Can't find the repository's server/ folder");
    }
}

[CollectionDefinition("server")]
public sealed class ServerCollection : ICollectionFixture<ServerFixture>
{
}

internal static class TempFolders
{
    /// <summary>Delete a folder, including the read-only files the client leaves in workspaces.</summary>
    public static void Delete(string folder)
    {
        if (!Directory.Exists(folder))
        {
            return;
        }
        foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }
        Directory.Delete(folder, recursive: true);
    }
}
