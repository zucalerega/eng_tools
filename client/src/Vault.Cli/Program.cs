using System.Diagnostics;
using System.Globalization;
using System.Text;
using Vault.Client;

namespace Vault.Cli;

internal static class Program
{
    private const string Usage = """
        vault: the team's CAD vault, for SolidWorks and STEP files, from the command line

        Usage: vault <command> [options] [paths...]

        Setting up
          login <server-url>             Sign in through your browser
          logout [<server-url>]          Forget the saved sign-in
          init [<folder>] --server <url> Create a workspace (default C:\VLT, or ~/VLT on macOS)
          whoami                         Who you're signed in as, on which computer

        Working
          status [paths]                 What's changed, out of date, or checked out (--all: everything)
          get [paths]                    Get the latest versions of files and folders, downloading what isn't here;
                                         with no paths, update just the files you have here (--force: replace
                                         your local changes; they're backed up)
          checkout <paths>               Check files out to edit them (alias: co; --force: take over a check-out
                                         on another computer: yours, or anyone's if you're a lead there)
          checkin <paths> -m "what"      Check in changed and new files (alias: ci; --keep: stay checked out)
          undo <paths>                   Undo your check-out; local changes are backed up in .vault/backup
          resolve <paths> --mine|--vault Settle conflicts (changed here, and a newer version in the vault since):
                                         --mine checks your copies out as they are, to check in on top; --vault
                                         takes the vault's versions (yours are backed up in .vault/backup)
          free [paths]                   Free up space: remove the copies here of files you haven't changed and
                                         don't have checked out (they stay in the vault; get brings them back)
          history <file>                 A file's versions (alias: log)
          locks [--mine]                 Who has what checked out
          title <file> "what it's called"  Give a file a title, shown with its name (its name is its part number,
                                         say): no new version, and no check-out

        Paths are files or folders inside the workspace; a folder means everything in it.
        With no paths, status, get, and free use the current folder: get updates the files you have in it,
        and `get .` downloads everything in it.
        """;

    private static readonly TokenStore Tokens = new TokenStore();

    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 0 || args[0] is "help" or "-h" or "--help")
        {
            Console.WriteLine(Usage);
            return 0;
        }
        try
        {
            var options = Options.Parse(args.Skip(1));
            return args[0] switch
            {
                "login" => await LoginAsync(options),
                "logout" => Logout(options),
                "init" => Init(options),
                "whoami" => await WhoAmIAsync(),
                "status" or "st" => await StatusAsync(options),
                "get" => await GetAsync(options),
                "checkout" or "co" => await CheckoutAsync(options),
                "checkin" or "ci" => await CheckinAsync(options),
                "undo" => await UndoAsync(options),
                "resolve" => await ResolveAsync(options),
                "free" => await FreeAsync(options),
                "history" or "log" => await HistoryAsync(options),
                "locks" => await LocksAsync(options),
                "title" => await TitleAsync(options),
                _ => throw new UsageException($"Unknown command '{args[0]}'. Run `vault help` for the list."),
            };
        }
        catch (UsageException e)
        {
            return Fail(e.Message, 2);
        }
        catch (VaultApiException e) when (e.StatusCode == 401)
        {
            return Fail("Your sign-in expired or was revoked. Run `vault login` again.");
        }
        catch (VaultApiException e)
        {
            return Fail(e.Message);
        }
        catch (Exception e) when (e is WorkspaceException or VaultPathException or TimeoutException)
        {
            return Fail(e.Message);
        }
        catch (HttpRequestException e)
        {
            return Fail($"Can't reach the server: {e.Message}");
        }
    }

    // --- setting up ---------------------------------------------------------------------------

    private static async Task<int> LoginAsync(Options options)
    {
        var server = ServerArgument(options) ?? throw new UsageException("Usage: vault login <server-url>");
        var name = $"vault CLI on {Environment.MachineName}";
        var issued = await BrowserSignIn.SignInAsync(server, name, OpenBrowser, TimeSpan.FromMinutes(5));
        Tokens.Save(server, issued.Token);
        Console.WriteLine($"Signed in to {server} as {issued.User.Name} ({issued.User.Email}).");
        return 0;
    }

    private static int Logout(Options options)
    {
        var server = ServerArgument(options) ?? throw new UsageException("Usage: vault logout <server-url>");
        Console.WriteLine(Tokens.Remove(server) ? $"Signed out of {server}." : $"You weren't signed in to {server}.");
        return 0;
    }

    private static int Init(Options options)
    {
        var folder = options.Paths.Count > 0 ? options.Paths[0] : Workspace.DefaultRoot;
        var server = options.Server is null ? throw new UsageException("Usage: vault init [<folder>] --server <url>") : ParseServer(options.Server);
        var token = Tokens.Load(server) ?? throw new WorkspaceException($"Sign in first: vault login {server}");
        using var workspace = Workspace.Create(folder, server, token);
        Console.WriteLine($"Created a vault workspace at {workspace.Root}. In it, `vault get <folder>` downloads a folder of the vault, and `vault get .` all of it.");
        return 0;
    }

    private static async Task<int> WhoAmIAsync()
    {
        using var workspace = OpenWorkspace();
        var me = await workspace.WhoAmIAsync();
        var admin = me.IsAdmin ? ", admin" : "";
        Console.WriteLine($"{me.Name} ({me.Email}{admin}) on {workspace.Host}, signed in to {workspace.Server}");
        return 0;
    }

    // --- working ------------------------------------------------------------------------------

    private static async Task<int> StatusAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        var statuses = await workspace.StatusAsync(PathsOrHere(options));
        var quiet = statuses.Where(s => s.State == FileState.UpToDate && s.Lock == null).ToList();
        foreach (var status in options.All ? statuses : statuses.Except(quiet))
        {
            Console.WriteLine(Describe(status));
        }
        if (statuses.Count == 0)
        {
            Console.WriteLine("No files here yet.");
        }
        else if (quiet.Count == statuses.Count)
        {
            Console.WriteLine($"All {Count(statuses.Count, "file")} up to date.");
        }
        else if (quiet.Count > 0)
        {
            Console.WriteLine($"{Count(quiet.Count, "other file")} up to date.");
        }
        return 0;
    }

    private static async Task<int> GetAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        // Paths named are got whole; with none, only what's here is updated, so the vault never comes down by accident.
        var result = options.Paths.Count > 0
            ? await workspace.GetLatestAsync(options.Paths, options.Force)
            : await workspace.UpdateAsync(PathsOrHere(options), options.Force);
        foreach (var status in result.Downloaded)
        {
            Console.WriteLine($"  got      v{status.LocalVersion}  {Show(status.LocalPath)}");
        }
        foreach (var status in result.Removed)
        {
            Console.WriteLine($"  removed      {Show(status.LocalPath)}  (deleted in the vault)");
        }
        foreach (var status in result.Skipped)
        {
            Console.WriteLine($"  skipped      {Show(status.LocalPath)}  (changed here; --force replaces it, keeping a backup)");
        }
        foreach (var copy in result.BackedUp)
        {
            Console.WriteLine($"  backed up    {Show(copy)}");
        }
        foreach (var failure in result.Failures)
        {
            Console.WriteLine($"  failed       {failure}");
        }
        Console.WriteLine($"Downloaded {Count(result.Downloaded.Count, "file")}.");
        return result.Skipped.Count > 0 || result.Failures.Count > 0 ? 1 : 0;
    }

    private static async Task<int> CheckoutAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        var statuses = await workspace.CheckoutAsync(RequirePaths(options), options.Force);
        foreach (var status in statuses)
        {
            Console.WriteLine($"  checked out  v{status.RemoteVersion}  {Show(status.LocalPath)}");
        }
        Console.WriteLine($"Checked out {Count(statuses.Count, "file")} to you on {workspace.Host}.");
        return 0;
    }

    private static async Task<int> CheckinAsync(Options options)
    {
        if (string.IsNullOrWhiteSpace(options.Message))
        {
            throw new UsageException("Say what changed: vault checkin <paths> -m \"what changed\"");
        }
        using var workspace = OpenWorkspace();
        var result = await workspace.CheckinAsync(RequirePaths(options), options.Message!, options.Keep);
        foreach (var file in result.Files)
        {
            Console.WriteLine($"  {file.Status,-9} v{file.File.Version}  {file.File.Path}");
        }
        var kept = options.Keep ? " You still have them checked out." : "";
        Console.WriteLine($"Checked in {Count(result.Files.Count, "file")}.{kept}");
        return 0;
    }

    private static async Task<int> FreeAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        var result = await workspace.FreeUpAsync(PathsOrHere(options));
        foreach (var status in result.Removed)
        {
            Console.WriteLine($"  freed        {Show(status.LocalPath)}");
        }
        foreach (var failure in result.Failures)
        {
            Console.WriteLine($"  kept         {failure}");
        }
        Console.WriteLine($"Freed {Megabytes(result.Bytes)}: {Count(result.Removed.Count, "file")} in the vault only, until you get them again.");
        return result.Failures.Count > 0 ? 1 : 0;
    }

    private static async Task<int> UndoAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        var result = await workspace.UndoCheckoutAsync(RequirePaths(options));
        foreach (var status in result.Released)
        {
            Console.WriteLine($"  released     {Show(status.LocalPath)}");
        }
        foreach (var copy in result.BackedUp)
        {
            Console.WriteLine($"  backed up    {Show(copy)}");
        }
        Console.WriteLine($"Undid the check-out of {Count(result.Released.Count, "file")}.");
        return 0;
    }

    private static async Task<int> ResolveAsync(Options options)
    {
        if (options.Mine == options.VaultVersion)
        {
            throw new UsageException("Say which to keep: vault resolve <paths> --mine for your copies, or --vault for the vault's versions");
        }
        using var workspace = OpenWorkspace();
        if (options.Mine)
        {
            var kept = await workspace.KeepMineAsync(RequirePaths(options));
            foreach (var status in kept)
            {
                Console.WriteLine($"  kept mine    {Show(status.LocalPath)}  (on top of v{status.RemoteVersion})");
            }
            Console.WriteLine($"Kept {Count(kept.Count, "file")} as yours, checked out to you on {workspace.Host}: check them in when they're ready.");
            return 0;
        }
        var result = await workspace.UseVaultVersionAsync(RequirePaths(options));
        foreach (var status in result.Downloaded)
        {
            Console.WriteLine($"  got      v{status.LocalVersion}  {Show(status.LocalPath)}");
        }
        foreach (var copy in result.BackedUp)
        {
            Console.WriteLine($"  backed up    {Show(copy)}");
        }
        foreach (var failure in result.Failures)
        {
            Console.WriteLine($"  failed       {failure}");
        }
        Console.WriteLine($"Replaced {Count(result.Downloaded.Count, "file")} with the vault's version.");
        return result.Failures.Count > 0 ? 1 : 0;
    }

    private static async Task<int> HistoryAsync(Options options)
    {
        if (options.Paths.Count != 1)
        {
            throw new UsageException("Usage: vault history <file>");
        }
        using var workspace = OpenWorkspace();
        var detail = await workspace.HistoryAsync(options.Paths[0]);
        var lockText = detail.File.CheckedOut is { } fileLock ? $"  (checked out by {fileLock.User.Name} on {fileLock.Host})" : "";
        Console.WriteLine(detail.File.Path + Titled(detail.File.Name, detail.File.Title) + lockText);
        if (detail.File.FormerNames is { Count: > 0 } former)
        {
            Console.WriteLine($"  formerly {string.Join(", ", former)}");
        }
        foreach (var version in detail.Versions)
        {
            Console.WriteLine($"  v{version.Number,-3} {When(version.CreatedAt)}  {version.Author.Name,-16} {version.Comment}");
            foreach (var reference in version.References)
            {
                Console.WriteLine($"         uses {reference.Path} v{reference.Version}{(reference.Deleted ? " (deleted)" : "")}");
            }
        }
        foreach (var use in detail.UsedBy)
        {
            Console.WriteLine($"  used by {use.File.Path} (v{use.UsesVersion})");
        }
        return 0;
    }

    private static async Task<int> LocksAsync(Options options)
    {
        using var workspace = OpenWorkspace();
        var files = await workspace.Api.CheckoutsAsync(options.Mine);
        foreach (var file in files)
        {
            var fileLock = file.CheckedOut!;
            Console.WriteLine($"  {file.Path}  {fileLock.User.Name} on {fileLock.Host} since {When(fileLock.Since)}");
        }
        Console.WriteLine(files.Count == 0 ? "Nothing is checked out." : $"{Count(files.Count, "file")} checked out.");
        return 0;
    }

    // --- helpers ------------------------------------------------------------------------------

    private static Workspace OpenWorkspace()
    {
        var root = Workspace.FindRoot(Environment.CurrentDirectory)
            ?? throw new WorkspaceException($"This isn't a vault workspace. Go to yours (usually {Workspace.DefaultRoot}) or create one with `vault init`.");
        var server = Workspace.ServerOf(root);
        var token = Tokens.Load(server) ?? throw new WorkspaceException($"Sign in first: vault login {server}");
        return Workspace.Open(root, token);
    }

    private static Uri? ServerArgument(Options options)
    {
        var text = options.Paths.FirstOrDefault() ?? options.Server;
        if (text != null)
        {
            return ParseServer(text);
        }
        var root = Workspace.FindRoot(Environment.CurrentDirectory);
        return root is null ? null : Workspace.ServerOf(root);
    }

    private static Uri ParseServer(string text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            ? uri
            : throw new UsageException($"'{text}' isn't a server address like https://yjsp.example.org");

    private static List<string> PathsOrHere(Options options) =>
        options.Paths.Count > 0 ? options.Paths : new List<string> { Environment.CurrentDirectory };

    private static List<string> RequirePaths(Options options) =>
        options.Paths.Count > 0 ? options.Paths : throw new UsageException("Say which files or folders (use . for this folder)");

    private static string Describe(FileStatus status)
    {
        var state = status.State switch
        {
            FileState.UpToDate => "up to date",
            FileState.Outdated => "out of date",
            FileState.Modified => "modified",
            FileState.Conflict => "CONFLICT",
            FileState.Missing => "not downloaded",
            FileState.New => "new",
            FileState.DeletedInVault => "deleted in vault",
            _ => status.State.ToString(),
        };
        var version = status.State switch
        {
            FileState.New => "",
            FileState.Outdated => $"v{status.LocalVersion}->v{status.RemoteVersion}",
            _ => $"v{status.RemoteVersion ?? status.LocalVersion}",
        };
        var lockText = status.Lock switch
        {
            null => "",
            _ when status.CheckedOutByMe => "  [checked out by you]",
            { } other => $"  [checked out by {other.User.Name} on {other.Host}]",
        };
        return $"  {state,-16} {version,-10} {Show(status.LocalPath)}{Titled(Path.GetFileName(status.VaultPath), status.Title)}{lockText}";
    }

    // A file's title after its name, where it says more than the name does (once someone named it, or the name is a
    // part number): "  “Fin bracket”".
    private static string Titled(string name, string? title)
    {
        var dot = name.LastIndexOf('.');
        var stem = dot > 0 ? name.Substring(0, dot) : name;
        return string.IsNullOrEmpty(title) || string.Equals(title, stem, StringComparison.OrdinalIgnoreCase) ? "" : $"  “{title}”";
    }

    private static async Task<int> TitleAsync(Options options)
    {
        if (options.Paths.Count < 2)
        {
            throw new UsageException("Usage: vault title <file> \"what it's called\"");
        }
        using var workspace = OpenWorkspace();
        var title = string.Join(" ", options.Paths.Skip(1));
        var described = await workspace.DescribeAsync(new[] { (options.Paths[0], (string?)title, (bool?)null) });
        foreach (var file in described)
        {
            Console.WriteLine($"{file.Path} is called “{file.Title}” now.");
        }
        return 0;
    }

    private static string Show(string localPath) => Path.GetRelativePath(Environment.CurrentDirectory, localPath);

    private static string When(DateTimeOffset time) =>
        time.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

    private static string Count(int count, string noun) => count == 1 ? $"1 {noun}" : $"{count} {noun}s";

    private static string Megabytes(long bytes) => (bytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";

    private static void OpenBrowser(Uri url)
    {
        Console.Error.WriteLine($"Opening your browser to sign in. If it doesn't open, go to:\n  {url.AbsoluteUri}");
        try
        {
            var start = OperatingSystem.IsWindows() ? new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true }
                : OperatingSystem.IsMacOS() ? new ProcessStartInfo("open", url.AbsoluteUri)
                : new ProcessStartInfo("xdg-open", url.AbsoluteUri);
            using var _ = Process.Start(start);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // No browser to open; the URL is printed above.
        }
    }

    private static int Fail(string message, int code = 1)
    {
        Console.Error.WriteLine("error: " + message);
        return code;
    }
}

internal sealed class Options
{
    public List<string> Paths { get; } = new List<string>();
    public string? Message { get; private set; }
    public string? Server { get; private set; }
    public bool Keep { get; private set; }
    public bool Force { get; private set; }
    public bool Mine { get; private set; }
    public bool VaultVersion { get; private set; }
    public bool All { get; private set; }

    public static Options Parse(IEnumerable<string> args)
    {
        var options = new Options();
        var queue = new Queue<string>(args);
        while (queue.Count > 0)
        {
            var arg = queue.Dequeue();
            switch (arg)
            {
                case "-m" or "--message":
                    options.Message = Value(queue, arg);
                    break;
                case "--server":
                    options.Server = Value(queue, arg);
                    break;
                case "--keep":
                    options.Keep = true;
                    break;
                case "--force":
                    options.Force = true;
                    break;
                case "--mine":
                    options.Mine = true;
                    break;
                case "--vault":
                    options.VaultVersion = true;
                    break;
                case "--all":
                    options.All = true;
                    break;
                case "--":
                    options.Paths.AddRange(queue);
                    queue.Clear();
                    break;
                default:
                    if (arg.Length > 1 && arg[0] == '-')
                    {
                        throw new UsageException($"Unknown option {arg}. Run `vault help`.");
                    }
                    options.Paths.Add(arg);
                    break;
            }
        }
        return options;
    }

    private static string Value(Queue<string> queue, string option) =>
        queue.Count > 0 ? queue.Dequeue() : throw new UsageException($"{option} needs a value");
}

internal sealed class UsageException : Exception
{
    public UsageException(string message)
        : base(message)
    {
    }
}
