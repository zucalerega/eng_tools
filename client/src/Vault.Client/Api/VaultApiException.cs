using System.Text.Json;

namespace Vault.Client;

/// <summary>
/// An error from the server: {"error": code, "message": ..., "details": ...}. Code is stable
/// (for example "checked_out", "not_checked_out", "pending_approval"); Message is for people.
/// </summary>
public sealed class VaultApiException : Exception
{
    public VaultApiException(int statusCode, string code, string message, JsonElement? details = null)
        : base(message)
    {
        StatusCode = statusCode;
        Code = code;
        Details = details;
    }

    public int StatusCode { get; }

    public string Code { get; }

    public JsonElement? Details { get; }
}
