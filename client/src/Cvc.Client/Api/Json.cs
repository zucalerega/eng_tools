using System.Text.Json;

namespace Cvc.Client;

internal static class Json
{
    /// <summary>The server's JSON uses snake_case names.</summary>
    public static readonly JsonSerializerOptions Options = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    /// <summary>For files people might open: workspace state and saved tokens.</summary>
    public static readonly JsonSerializerOptions Indented = new JsonSerializerOptions(Options) { WriteIndented = true };
}
