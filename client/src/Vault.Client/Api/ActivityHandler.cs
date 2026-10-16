namespace Vault.Client;

/// <summary>
/// Says, on each request, when someone is working in SolidWorks, so Admin > People counts that time beside the time the
/// web app is open (the server's auth.authenticate). The add-in decides what working in it is; this only asks it. The
/// header's name and value are part of the API.
/// </summary>
public sealed class ActivityHandler : DelegatingHandler
{
    public const string Header = "X-YJSP-Activity";
    public const string InSolidWorks = "solidworks";

    private readonly Func<bool> _inSolidWorks;

    /// <param name="inSolidWorks">Whether someone is working in SolidWorks now. It's asked on whatever thread a request
    /// starts on, so it mustn't touch SolidWorks.</param>
    /// <param name="inner">Where requests go next: the network, unless given.</param>
    public ActivityHandler(Func<bool> inSolidWorks, HttpMessageHandler? inner = null)
        : base(inner ?? new HttpClientHandler())
    {
        _inSolidWorks = inSolidWorks;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (_inSolidWorks())
        {
            request.Headers.TryAddWithoutValidation(Header, InSolidWorks);
        }
        return base.SendAsync(request, cancellationToken);
    }
}
