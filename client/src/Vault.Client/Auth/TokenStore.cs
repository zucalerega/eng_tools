using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Vault.Client;

/// <summary>
/// Saved sign-in tokens, one per server. On Windows they're encrypted with DPAPI (only this
/// Windows account can read them); elsewhere the file is readable by its owner only.
/// </summary>
public sealed class TokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("vault-token");

    // Before 0.4.0, when the client was CVC's, sign-ins were kept in %APPDATA%\CVC (or ~/.config/cvc) and encrypted
    // with this. They're read from there once, when there are none here yet, so nobody has to sign in again; the old
    // file stays, for a cvc.exe still on the computer.
    private static readonly byte[] OldEntropy = Encoding.UTF8.GetBytes("cvc-token");
    private readonly string? _oldFilePath;

    /// <summary>
    /// The sign-ins at filePath (default: DefaultPath()), taking over those at oldFilePath (default: where they were
    /// before 0.4.0) while it has none.
    /// </summary>
    public TokenStore(string? filePath = null, string? oldFilePath = null)
    {
        FilePath = filePath ?? DefaultPath();
        _oldFilePath = filePath == null ? OldDefaultPath() : oldFilePath;
    }

    public string FilePath { get; }

    public static string DefaultPath() => PathIn("Vault", "vault");

    private static string OldDefaultPath() => PathIn("CVC", "cvc");

    private static string PathIn(string windowsFolder, string configFolder)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), windowsFolder, "tokens.json");
        }
        var config = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrEmpty(config))
        {
            config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        }
        return Path.Combine(config, configFolder, "tokens.json");
    }

    public string? Load(Uri server) => Read().TryGetValue(Key(server), out var stored) ? Unprotect(stored, Entropy) : null;

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

    private static string Key(Uri server) => VaultApi.WithTrailingSlash(server).AbsoluteUri;

    private Dictionary<string, string> Read()
    {
        if (!File.Exists(FilePath) && _oldFilePath != null && File.Exists(_oldFilePath))
        {
            return TakeOverOld(_oldFilePath);
        }
        return ReadFile(FilePath);
    }

    /// <summary>
    /// The sign-ins saved before 0.4.0, encrypted again and saved here. Any that can't be read are left out: sign in
    /// again.
    /// </summary>
    private Dictionary<string, string> TakeOverOld(string oldFilePath)
    {
        var tokens = new Dictionary<string, string>();
        foreach (var saved in ReadFile(oldFilePath))
        {
            if (Unprotect(saved.Value, OldEntropy) is { } token)
            {
                tokens[saved.Key] = Protect(token);
            }
        }
        Write(tokens);
        return tokens;
    }

    private static Dictionary<string, string> ReadFile(string path)
    {
        if (!File.Exists(path))
        {
            return new Dictionary<string, string>();
        }
        return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))
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

    private static string? Unprotect(string stored, byte[] entropy)
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
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null; // saved by another Windows account, or damaged: sign in again
        }
    }
}
