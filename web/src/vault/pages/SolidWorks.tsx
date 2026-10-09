import { useEffect, useState } from "react";
import { api, type Download } from "../../api";
import { Notice } from "../../components";
import { connectLink } from "../components";
import { formatSize } from "../../format";

const INSTALLER = "vault-setup.exe";
// What the files an admin puts in the server's downloads folder are, for the ones Vault makes.
const KNOWN: Record<string, string> = {
    "vault.exe": "The command line, for scripts and for working without SolidWorks (Windows).",
};

/** Getting Vault into SolidWorks: download the add-in's installer, then connect it to this vault. */
export function SolidWorks() {
    const [downloads, setDownloads] = useState<Download[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        api.downloads().then(setDownloads, (error: Error) => setProblem(error.message));
    }, []);
    const installer = downloads?.find((download) => download.name.toLowerCase() === INSTALLER);
    const others = downloads?.filter((download) => download !== installer) ?? [];
    return (
        <section className="software">
            <h1>SolidWorks</h1>
            <p className="lead">
                The add-in puts a Vault tab in SolidWorks 2025: check files out and in, open assemblies with everything
                they use, and see who has what checked out, without leaving SolidWorks. The Open in SolidWorks and New
                part buttons here use it too.
            </p>
            {problem && <Notice tone="error">{problem}</Notice>}
            <ol className="steps">
                <li>
                    <h2>Install the add-in</h2>
                    {installer ? (
                        <>
                            <p>
                                <a className="button button-primary" href={api.downloadsUrl(installer.name)} download>
                                    Download {installer.name}
                                </a>{" "}
                                <span className="muted">{formatSize(installer.size)}, for Windows</span>
                            </p>
                            <p>
                                Close SolidWorks, then run it. It asks for administrator rights, to register the add-in
                                with SolidWorks. If Windows says it protected your PC, click <strong>More info</strong>,
                                then <strong>Run anyway</strong>.
                            </p>
                        </>
                    ) : downloads ? (
                        <p>This server doesn't have the installer yet: ask an admin for Vault-Setup.exe.</p>
                    ) : (
                        !problem && <p className="muted">Loading…</p>
                    )}
                </li>
                <li>
                    <h2>Connect it to this vault</h2>
                    <p>
                        <a className="button" href={connectLink()}>
                            Connect SolidWorks
                        </a>
                    </p>
                    <p>
                        SolidWorks starts with the Vault tab open, and your browser asks you to let it in. Then C:\VLT
                        has a folder for each of the vault's folders: save new parts in the one they belong in, and
                        check them in from the Vault tab.
                    </p>
                </li>
            </ol>
            <h2>Using it</h2>
            <ul className="how-to">
                <li>
                    <strong>Open files</strong> from the Browse list in the Vault tab, or with Open in SolidWorks here.
                    An assembly brings the parts it uses along; nothing else is downloaded until you need it.
                </li>
                <li>
                    <strong>Insert</strong> a part or assembly from the vault into the assembly you have open:
                    right-click it in the Browse list and choose Insert into. It's downloaded first if it isn't on your
                    computer.
                </li>
                <li>
                    <strong>Check out</strong> a file before you change it, so nobody else changes it at the same time.
                    Start editing one and Vault offers to.
                </li>
                <li>
                    <strong>Check in</strong> with a comment to save a new version for everyone. An assembly takes its
                    new and changed parts with it.
                </li>
                <li>
                    <strong>Update downloaded files</strong> gets the latest versions of the files on your computer.
                </li>
                <li>
                    <strong>New part</strong> in a folder here, or <strong>New drawing</strong> on a part's page, starts
                    it in SolidWorks, already in the vault and checked out to you.
                </li>
            </ul>
            <h2>If something's not right</h2>
            <div className="faq">
                <details>
                    <summary>There's no Vault tab in SolidWorks</summary>
                    <p>
                        In SolidWorks, open <strong>Tools &gt; Add-ins</strong> and tick Vault in both columns, so it
                        loads now and every time SolidWorks starts. This happens when setup ran as another Windows user.
                    </p>
                </details>
                <details>
                    <summary>Connect SolidWorks doesn't do anything</summary>
                    <p>
                        Install the add-in first (step 1): it's what follows the link. If your browser asks whether to
                        open it, say yes.
                    </p>
                </details>
                <details>
                    <summary>SolidWorks is set up for another vault</summary>
                    <p>
                        Each vault needs a folder of its own. In the Vault tab, sign out, type another folder (like
                        C:\VLT-2), then connect again.
                    </p>
                </details>
                <details>
                    <summary>Windows won't run Vault-Setup.exe</summary>
                    <p>
                        It isn't signed yet, so Windows is careful with it: click <strong>More info</strong>, then{" "}
                        <strong>Run anyway</strong>. Your browser may ask whether to keep the download first.
                    </p>
                </details>
                <details>
                    <summary>Something else</summary>
                    <p>The add-in keeps a log in %LOCALAPPDATA%\Vault\addin.log: send it to whoever runs your vault.</p>
                </details>
            </div>
            {others.length > 0 && (
                <>
                    <h2>Other downloads</h2>
                    <ul className="plain downloads">
                        {others.map((download) => (
                            <li key={download.name}>
                                <a href={api.downloadsUrl(download.name)} download>
                                    {download.name}
                                </a>
                                <span className="muted">
                                    {formatSize(download.size)}
                                    {KNOWN[download.name.toLowerCase()] && ` · ${KNOWN[download.name.toLowerCase()]}`}
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}
