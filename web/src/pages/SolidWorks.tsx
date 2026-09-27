import { useEffect, useState } from "react";
import { api, type Download } from "../api";
import { connectLink, Notice } from "../components";
import { formatSize } from "../format";

const INSTALLER = "vault-setup.exe";
// What the files an admin puts in the server's downloads folder are, for the ones Vault makes.
const KNOWN: Record<string, string> = {
    "cvc.exe": "The command line, for scripts and for working without SolidWorks (Windows).",
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
            <h1>Vault in SolidWorks</h1>
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
                        SolidWorks starts with the Vault tab open, and your browser asks you to let it in. Your copies
                        of vault files go in C:\CVC.
                    </p>
                </li>
            </ol>
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
