using System;
using System.IO;
using System.Threading;
using Cvc.SolidWorks.Open;

namespace Cvc.SolidWorks;

/// <summary>
/// Takes cvc:// links from cvc-open.exe (the web app's "Open in SolidWorks") over this session's
/// pipe, one at a time, and has the task pane open them.
/// </summary>
internal sealed class LinkListener : IDisposable
{
    private readonly CvcPane _pane;
    private readonly Thread _thread;
    private volatile bool _stopping;
    private volatile Stream? _pipe;

    public LinkListener(CvcPane pane)
    {
        _pane = pane;
        _thread = new Thread(Listen) { IsBackground = true, Name = "CVC links" };
        _thread.Start();
    }

    public void Dispose()
    {
        _stopping = true;
        _pipe?.Dispose(); // ends the wait for the next link
    }

    private void Listen()
    {
        while (!_stopping)
        {
            try
            {
                using var pipe = OpenPipe.Listen();
                _pipe = pipe;
                pipe.WaitForConnection();
                var link = OpenPipe.Read(pipe);
                if (link != null)
                {
                    OpenPipe.Write(pipe, _pane.OpenLinkFromAnotherThread(link));
                }
            }
            catch (Exception) when (_stopping)
            {
                return;
            }
            catch (Exception e)
            {
                // Another SolidWorks may have this session's pipe, or a link came in badly. Keep listening.
                Log.Error("Couldn't take a link from the web app", e);
                Thread.Sleep(TimeSpan.FromSeconds(5));
            }
        }
    }
}
