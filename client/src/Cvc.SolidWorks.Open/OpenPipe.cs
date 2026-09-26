using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Cvc.SolidWorks.Open;

/// <summary>
/// How cvc-open.exe hands a link to the add-in in SolidWorks: a named pipe for this Windows session
/// that only this user can open. cvc-open writes the link as one line; the add-in answers with
/// one line, empty if it opened the file, or else saying what went wrong.
/// </summary>
public static class OpenPipe
{
    private const int MaxLine = 64 * 1024;

    public static string Name(int sessionId) => "cvc-solidworks-open-" + sessionId;

    /// <summary>For the add-in: this session's pipe, which nobody but the current user can connect to.</summary>
    public static NamedPipeServerStream Listen()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(
            Name(Process.GetCurrentProcess().SessionId), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
    }

    public static void Write(Stream pipe, string line)
    {
        var bytes = Encoding.UTF8.GetBytes(line.Replace('\r', ' ').Replace('\n', ' ') + "\n");
        pipe.Write(bytes, 0, bytes.Length);
        pipe.Flush();
    }

    /// <summary>One line, or null if the other side hung up first.</summary>
    public static string? Read(Stream pipe)
    {
        var line = new MemoryStream();
        while (line.Length < MaxLine)
        {
            var next = pipe.ReadByte();
            if (next < 0)
            {
                return null;
            }
            if (next == '\n')
            {
                return Encoding.UTF8.GetString(line.ToArray());
            }
            line.WriteByte((byte)next);
        }
        return null;
    }
}
