using System;
using System.IO;
using System.Threading;
using Vault.SolidWorks.Open;

namespace Vault.SolidWorks;

/// <summary>
/// Takes vault:// links from vault-open.exe (the web app's "Open in SolidWorks") over this session's
/// pipe, one at a time, and has the task pane open them.
/// </summary>
internal sealed class LinkListener : IDisposable
{
    private readonly VaultPane _pane;
    private readonly Thread _thread;
    private volatile bool _stopping;
    private volatile Stream? _pipe;

    public LinkListener(VaultPane pane)
    {
        _pane = pane;
        _thread = new Thread(Listen) { IsBackground = true, Name = "Vault links" };
        _thread.Start();
    }

    public void Dispose()
    {
        _stopping = true;
        _pipe?.Dispose(); // ends the wait for the next link
    }

    private void Listen()
    {
        string? failing = null;
        while (!_stopping)
        {
            try
            {
                using var pipe = OpenPipe.Listen();
                _pipe = pipe;
                pipe.WaitForConnection();
                failing = null;
                var link = OpenPipe.Read(pipe);
                if (link != null)
                {
                    // In the log, so it says what happened to a click in the web app: vault-open.exe's lines are there too.
                    Log.Info("Link from the web app: " + link);
                    var answer = _pane.OpenLinkFromAnotherThread(link);
                    Log.Info(answer.Length == 0 ? "Done with the link" : "Didn't follow the link: " + answer);
                    OpenPipe.Write(pipe, answer);
                }
            }
            catch (Exception) when (_stopping)
            {
                return;
            }
            catch (Exception e)
            {
                // Another SolidWorks may have this session's pipe, or a link came in badly. Keep listening, and say so once,
                // not every few seconds: that would push what explains other problems out of the log.
                if (e.Message != failing)
                {
                    Log.Error("Couldn't take a link from the web app", e);
                    failing = e.Message;
                }
                Thread.Sleep(TimeSpan.FromSeconds(5));
            }
        }
    }
}
