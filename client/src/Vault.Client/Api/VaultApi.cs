using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Vault.Client;

/// <summary>The server's HTTP API for Vault. See docs/vault.md and docs/design.md, "API".</summary>
public sealed class VaultApi : IDisposable
{
    private readonly HttpClient _http;

    public VaultApi(Uri server, string? token = null, HttpMessageHandler? handler = null)
    {
        Server = WithTrailingSlash(server);
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.BaseAddress = Server;
        _http.Timeout = TimeSpan.FromHours(1); // big files on slow connections
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("vault-client/" + typeof(VaultApi).Assembly.GetName().Version);
        if (token != null)
        {
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    public Uri Server { get; }

    public void Dispose() => _http.Dispose();

    public Task<Account> MeAsync(CancellationToken ct = default) => GetAsync<Account>("api/me", ct);

    public Task<SyncResult> SyncAsync(long since, CancellationToken ct = default) =>
        GetAsync<SyncResult>("api/sync?since=" + since.ToString(CultureInfo.InvariantCulture), ct);

    public Task<FolderListing> ListAsync(string path, bool deleted = false, CancellationToken ct = default) =>
        GetAsync<FolderListing>("api/folders?path=" + Uri.EscapeDataString(path) + (deleted ? "&deleted=true" : ""), ct);

    public Task<FileDetail> FileAsync(long fileId, CancellationToken ct = default) =>
        GetAsync<FileDetail>("api/files/" + fileId.ToString(CultureInfo.InvariantCulture), ct);

    public async Task<List<VaultFile>> CheckoutsAsync(bool mine = false, CancellationToken ct = default) =>
        (await GetAsync<FileList>(mine ? "api/checkouts?mine=true" : "api/checkouts", ct).ConfigureAwait(false)).Files;

    public async Task DownloadAsync(long fileId, int version, Stream destination, CancellationToken ct = default)
    {
        var uri = string.Format(CultureInfo.InvariantCulture, "api/files/{0}/content?version={1}", fileId, version);
        using var response = await _http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(response).ConfigureAwait(false);
        using var body = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
        await body.CopyToAsync(destination, 81920, ct).ConfigureAwait(false);
    }

    /// <summary>What the server offers for download, like the add-in's installer.</summary>
    public Task<List<Download>> DownloadsAsync(CancellationToken ct = default) => GetAsync<List<Download>>("api/downloads", ct);

    /// <summary>One of the downloads, by name.</summary>
    public async Task DownloadSoftwareAsync(string name, Stream destination, CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("api/downloads/" + Uri.EscapeDataString(name), HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(response).ConfigureAwait(false);
        using var body = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
        await body.CopyToAsync(destination, 81920, ct).ConfigureAwait(false);
    }

    /// <summary>Whether the server already has these contents, so the upload can be skipped.</summary>
    public async Task<bool> HasBlobAsync(string sha256, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, "api/blobs/" + sha256);
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return false;
        }
        await EnsureSuccessAsync(response).ConfigureAwait(false);
        return true;
    }

    /// <summary>Upload file contents. The server checks them against the SHA-256.</summary>
    public async Task UploadBlobAsync(string sha256, Stream content, CancellationToken ct = default)
    {
        using var body = new StreamContent(content, 81920);
        body.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await _http.PutAsync("api/blobs/" + sha256, body, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(response).ConfigureAwait(false);
    }

    /// <summary>
    /// Lock files for this computer: all of them, or none (a "checked_out" error says who has them).
    /// With force, take over check-outs elsewhere: your own, or anyone's if you're a lead there.
    /// </summary>
    public async Task<List<VaultFile>> CheckoutAsync(IEnumerable<string> paths, string host, bool force = false, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/checkout", new { files = paths.ToList(), host, force }, ct).ConfigureAwait(false)).Files;

    /// <summary>Recent events you can see, newest first; with fileId, only that file's.</summary>
    public Task<List<VaultEvent>> ActivityAsync(long? fileId = null, int limit = 100, CancellationToken ct = default) =>
        GetAsync<List<VaultEvent>>(
            "api/activity?limit=" + limit.ToString(CultureInfo.InvariantCulture)
            + (fileId is { } id ? "&file_id=" + id.ToString(CultureInfo.InvariantCulture) : ""),
            ct);

    public async Task<List<VaultFile>> UndoCheckoutAsync(IEnumerable<string> paths, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/undo-checkout", new { files = paths.ToList() }, ct).ConfigureAwait(false)).Files;

    public Task<CheckinResult> CheckinAsync(CheckinRequest request, CancellationToken ct = default) =>
        PostAsync<CheckinResult>("api/checkin", request, ct);

    public async Task<List<VaultFile>> DeleteAsync(IEnumerable<string> paths, bool force = false, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/delete", new { files = paths.ToList(), force }, ct).ConfigureAwait(false)).Files;

    /// <summary>Move files and folders (vault paths) into a folder, made if it isn't there.</summary>
    public Task<Moved> MoveAsync(IEnumerable<string> files, IEnumerable<string> folders, string to, CancellationToken ct = default) =>
        PostAsync<Moved>("api/move", new { files = files.ToList(), folders = folders.ToList(), to }, ct);

    /// <summary>Rename a file (keeping its type) or a folder, by vault path: give one of them.</summary>
    public Task<Moved> RenameAsync(string? file, string? folder, string name, CancellationToken ct = default) =>
        PostAsync<Moved>("api/rename", new { file, folder, name }, ct);

    /// <summary>The last step of browser sign-in (see BrowserSignIn).</summary>
    public Task<IssuedToken> RedeemSignInCodeAsync(string code, string verifier, CancellationToken ct = default) =>
        PostAsync<IssuedToken>("auth/client/token", new { code, verifier }, ct);

    /// <summary>Development servers only (YJSP_DEV_AUTH): a token for any email, without Google.</summary>
    public Task<IssuedToken> DevTokenAsync(string email, string name = "", CancellationToken ct = default) =>
        PostAsync<IssuedToken>("auth/dev-token", new { email, name }, ct);

    internal static Uri WithTrailingSlash(Uri server) =>
        server.AbsoluteUri.EndsWith("/", StringComparison.Ordinal) ? server : new Uri(server.AbsoluteUri + "/");

    private async Task<T> GetAsync<T>(string uri, CancellationToken ct)
    {
        using var response = await _http.GetAsync(uri, ct).ConfigureAwait(false);
        return await ReadAsync<T>(response).ConfigureAwait(false);
    }

    private async Task<T> PostAsync<T>(string uri, object body, CancellationToken ct)
    {
        using var content = new StringContent(JsonSerializer.Serialize(body, Json.Options), Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(uri, content, ct).ConfigureAwait(false);
        return await ReadAsync<T>(response).ConfigureAwait(false);
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response)
    {
        await EnsureSuccessAsync(response).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        return JsonSerializer.Deserialize<T>(text, Json.Options)
            ?? throw new VaultApiException((int)response.StatusCode, "bad_response", "The server sent an empty response");
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        throw ParseError((int)response.StatusCode, response.ReasonPhrase, text);
    }

    internal static VaultApiException ParseError(int status, string? reason, string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("error", out var code) && code.ValueKind == JsonValueKind.String)
                {
                    var message = root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
                    JsonElement? details = root.TryGetProperty("details", out var d) ? d.Clone() : null;
                    return new VaultApiException(status, code.GetString() ?? "error", message ?? reason ?? "Request failed", details);
                }
                if (root.TryGetProperty("detail", out var detail))
                {
                    return new VaultApiException(status, "invalid_request", "The server rejected the request: " + detail.GetRawText());
                }
            }
        }
        catch (JsonException)
        {
            // Not JSON (a proxy's error page, say); fall through to the generic message.
        }
        var snippet = body.Length > 200 ? body.Substring(0, 200) : body;
        var text = string.Format(CultureInfo.InvariantCulture, "{0} {1} {2}", status, reason, snippet).Trim();
        return new VaultApiException(status, "http_error", text);
    }
}
