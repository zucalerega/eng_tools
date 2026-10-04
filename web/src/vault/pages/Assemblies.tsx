import { useVault } from "../store";
import { topAssemblies } from "../structure";
import { FileTable } from "./Browse";

/** The product structure: top-level assemblies, each opening up into its sub-assemblies and parts. */
export function Assemblies() {
    const vault = useVault();
    const top = topAssemblies(vault);
    return (
        <section>
            <div className="page-head">
                <h1>Assemblies</h1>
            </div>
            <p className="muted">
                Top-level assemblies: the ones no other assembly uses. Open one up to see its sub-assemblies and parts,
                wherever they're kept, and whether each is checked in.
            </p>
            {top.length === 0 ? (
                <p className="empty">There are no assemblies in the vault yet.</p>
            ) : (
                <FileTable files={top} withPaths />
            )}
        </section>
    );
}
