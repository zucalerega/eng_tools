using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Cvc.Client;

/// <summary>The CVC server's HTTP API. See docs/design.md, "API".</summary>
public sealed class CvcApi : IDisposable
{
    private readonly HttpClient _http;

    public CvcApi(Uri server, string? token = null, HttpMessageHandler? handler = null)
    {
        Server = WithTrailingSlash(server);
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.BaseAddress = Server;
        _http.Timeout = TimeSpan.FromHours(1); // big files on slow connections
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("cvc-client/" + typeof(CvcApi).Assembly.GetName().Version);
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

    /// <summary>Lock files for this computer: all of them, or none (a "checked_out" error says who has them).</summary>
    public async Task<List<VaultFile>> CheckoutAsync(IEnumerable<string> paths, string host, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/checkout", new { files = paths.ToList(), host }, ct).ConfigureAwait(false)).Files;

    public async Task<List<VaultFile>> UndoCheckoutAsync(IEnumerable<string> paths, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/undo-checkout", new { files = paths.ToList() }, ct).ConfigureAwait(false)).Files;

    public Task<CheckinResult> CheckinAsync(CheckinRequest request, CancellationToken ct = default) =>
        PostAsync<CheckinResult>("api/checkin", request, ct);

    public async Task<List<VaultFile>> DeleteAsync(IEnumerable<string> paths, bool force = false, CancellationToken ct = default) =>
        (await PostAsync<FileList>("api/delete", new { files = paths.ToList(), force }, ct).ConfigureAwait(false)).Files;

    /// <summary>The last step of browser sign-in (see BrowserSignIn).</summary>
    public Task<IssuedToken> RedeemSignInCodeAsync(string code, string verifier, CancellationToken ct = default) =>
        PostAsync<IssuedToken>("auth/client/token", new { code, verifier }, ct);

    /// <summary>Development servers only (CVC_DEV_AUTH): a token for any email, without Google.</summary>
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
            ?? throw new CvcApiException((int)response.StatusCode, "bad_response", "The server sent an empty response");
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

    internal static CvcApiException ParseError(int status, string? reason, string body)
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
                    return new CvcApiException(status, code.GetString() ?? "error", message ?? reason ?? "Request failed", details);
                }
                if (root.TryGetProperty("detail", out var detail))
                {
                    return new CvcApiException(status, "invalid_request", "The server rejected the request: " + detail.GetRawText());
                }
            }
        }
        catch (JsonException)
        {
            // Not JSON (a proxy's error page, say); fall through to the generic message.
        }
        var snippet = body.Length > 200 ? body.Substring(0, 200) : body;
        var text = string.Format(CultureInfo.InvariantCulture, "{0} {1} {2}", status, reason, snippet).Trim();
        return new CvcApiException(status, "http_error", text);
    }
}
