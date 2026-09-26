using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Cvc.Client;

/// <summary>
/// Saved sign-in tokens, one per server. On Windows they're encrypted with DPAPI (only this
/// Windows account can read them); elsewhere the file is readable by its owner only.
/// </summary>
public sealed class TokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("cvc-token");

    public TokenStore(string? filePath = null) => FilePath = filePath ?? DefaultPath();

    public string FilePath { get; }

    public static string DefaultPath()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CVC", "tokens.json");
        }
        var config = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrEmpty(config))
        {
            config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        }
        return Path.Combine(config, "cvc", "tokens.json");
    }

    public string? Load(Uri server) => Read().TryGetValue(Key(server), out var stored) ? Unprotect(stored) : null;

    public void Save(Uri server, string token)
    {
        var tokens = Read();
        tokens[Key(server)] = Protect(token);
        Write(tokens);
    }

    public bool Remove(Uri server)
    {
        var tokens = Read();
        if (!tokens.Remove(Key(server)))
        {
            return false;
        }
        Write(tokens);
        return true;
    }

    private static string Key(Uri server) => CvcApi.WithTrailingSlash(server).AbsoluteUri;

    private Dictionary<string, string> Read()
    {
        if (!File.Exists(FilePath))
        {
            return new Dictionary<string, string>();
        }
        return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(FilePath))
            ?? new Dictionary<string, string>();
    }

    private void Write(Dictionary<string, string> tokens)
    {
        var json = JsonSerializer.Serialize(tokens, Json.Indented);
        var folder = Path.GetDirectoryName(FilePath)!;
#if NET7_0_OR_GREATER
        if (!OperatingSystem.IsWindows())
        {
            const UnixFileMode ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            Directory.CreateDirectory(folder, ownerOnly | UnixFileMode.UserExecute);
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, UnixCreateMode = ownerOnly };
            using (var stream = new FileStream(FilePath, options))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(json);
            }
            File.SetUnixFileMode(FilePath, ownerOnly); // in case the file already existed with wider permissions
            return;
        }
#endif
        Directory.CreateDirectory(folder);
        File.WriteAllText(FilePath, json);
    }

    private static string Protect(string token)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser);
            return "dpapi:" + Convert.ToBase64String(encrypted);
        }
        return "plain:" + token;
    }

    private static string? Unprotect(string stored)
    {
        if (stored.StartsWith("plain:", StringComparison.Ordinal))
        {
            return stored.Substring("plain:".Length);
        }
        if (!stored.StartsWith("dpapi:", StringComparison.Ordinal) || !RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return null;
        }
        try
        {
            var encrypted = Convert.FromBase64String(stored.Substring("dpapi:".Length));
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null; // saved by another Windows account, or damaged: sign in again
        }
    }
}
