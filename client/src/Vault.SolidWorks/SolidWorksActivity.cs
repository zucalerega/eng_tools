using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Vault.SolidWorks;

/// <summary>
/// Whether someone is working in SolidWorks now, for the time Admin > People counts (see ActivityHandler): SolidWorks
/// has the foreground (its window or one of its dialogs, so any of this process's windows), and the keyboard or mouse
/// was used in the last few minutes. SolidWorks left open behind other windows, or overnight, isn't. It asks Windows,
/// not SolidWorks, so any thread may call it.
/// </summary>
internal static class SolidWorksActivity
{
    // Longer than this without a key or the mouse, nobody's at the computer.
    private static readonly uint IdleMs = (uint)TimeSpan.FromMinutes(5).TotalMilliseconds;
    private static readonly uint ProcessId = (uint)Process.GetCurrentProcess().Id;

    public static bool InUse()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out var process) == 0 || process != ProcessId)
        {
            return false;
        }
        var input = new LastInputInfo { Size = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
        // Both are milliseconds since Windows started, wrapping alike, so the difference is right across a wrap.
        return GetLastInputInfo(ref input) && unchecked((uint)Environment.TickCount - input.Time) < IdleMs;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint Size;
        public uint Time;
    }
}
