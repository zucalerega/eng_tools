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
                The add-in puts a Vault tab in SolidWorks 2026: check files out and in, open assemblies with everything
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
                                <span className="muted">
                                    {installer.version && `Version ${installer.version}, `}
                                    {formatSize(installer.size)}, for SolidWorks 2026 on Windows
                                </span>
                            </p>
                            <p>
                                Close SolidWorks, then run it. It asks for administrator rights, to register the add-in
                                with SolidWorks. If Windows says it protected your PC, click <strong>More info</strong>,
                                then <strong>Run anyway</strong>.
                            </p>
                            <p>
                                Have the add-in already? When there's a newer one, <strong>Update</strong> appears at
                                the top of the Vault tab. Running this setup again updates it too, and keeps your
                                sign-in and workspace. It installs the add-in new only with SolidWorks 2026; with
                                SolidWorks 2025, it only updates one that's there.
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
                    it in SolidWorks, already in the vault and checked out to you. Once part numbers are on, a new part
                    or assembly gets its number here first: say what kind it is and what it's called, and its name is
                    the number. In SolidWorks, right-click a folder in the Vault tab's Browse for{" "}
                    <strong>New part</strong> or <strong>New assembly</strong>, which do the same.
                </li>
                <li>
                    <strong>Titles</strong> show after files' names in Browse and under the open file's name, where they
                    say more than the name does (a part number's). Right-click a file for <strong>Edit title</strong>.
                    Checking in new parts without part numbers, tick that they're vendors' parts (a McMaster screw,
                    say), which keep their names.
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
                    <summary>Open in SolidWorks doesn't open the file</summary>
                    <p>
                        If nothing at all happens, the add-in isn't installed on this computer (step 1), or your browser
                        asked whether to open vault-open.exe and was told no: click again, and say yes.
                    </p>
                    <p>
                        Otherwise Vault says why. A Vault message on top of SolidWorks means the add-in didn't get the
                        file: it's turned off (tick Vault in both columns of <strong>Tools &gt; Add-ins</strong>), or
                        it's still busy with the last file you opened. Once it has the file, the Vault tab comes to the
                        front and says what it's doing, and a message says what went wrong, like a file saved in a newer
                        SolidWorks than yours.
                    </p>
                </details>
                <details>
                    <summary>An assembly opens with parts missing</summary>
                    <p>
                        Open it from the Browse list in the Vault tab, or with Open in SolidWorks here: Vault gets
                        everything it uses first, at every level, STEP files placed in it with 3D Interconnect included.
                        Whatever the vault doesn't have, the Vault tab names, like parts left in Kenesto or saved only
                        on someone's computer. Add those to the vault (upload them here, or check them in from
                        SolidWorks), or take them out of the assembly.
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
                    <p>
                        The add-in keeps a log in %LOCALAPPDATA%\Vault\addin.log, with a line for each click on Open in
                        SolidWorks: send it to whoever runs your vault.
                    </p>
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
