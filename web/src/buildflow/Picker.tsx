import type { ProgramDetail } from "./api";

/** The program's components to pick from, by subsystem, each subsystem's all at once too: for a review, or for what a
 * component needs first. */
export function ComponentPicker({
    program,
    picked,
    onChange,
    except,
}: {
    program: ProgramDetail;
    picked: number[];
    onChange: (ids: number[]) => void;
    except?: number; // one not to offer: the component whose needs these are
}) {
    return (
        <div className="bf-picker">
            {program.subsystems.map((subsystem) => {
                const inside = program.components.filter((c) => c.subsystem_id === subsystem.id && c.id !== except);
                if (inside.length === 0) {
                    return null;
                }
                const all = inside.every((c) => picked.includes(c.id));
                const some = inside.some((c) => picked.includes(c.id));
                return (
                    <fieldset key={subsystem.id} className="bf-picker-group">
                        <legend>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={all}
                                    ref={(box) => {
                                        if (box) {
                                            box.indeterminate = some && !all;
                                        }
                                    }}
                                    onChange={() =>
                                        onChange(
                                            all
                                                ? picked.filter((id) => !inside.some((c) => c.id === id))
                                                : [
                                                      ...picked,
                                                      ...inside.filter((c) => !picked.includes(c.id)).map((c) => c.id),
                                                  ],
                                        )
                                    }
                                />
                                All of {subsystem.name}
                            </label>
                        </legend>
                        {inside.map((component) => (
                            <label key={component.id} className="check">
                                <input
                                    type="checkbox"
                                    checked={picked.includes(component.id)}
                                    onChange={() =>
                                        onChange(
                                            picked.includes(component.id)
                                                ? picked.filter((id) => id !== component.id)
                                                : [...picked, component.id],
                                        )
                                    }
                                />
                                {component.name}
                            </label>
                        ))}
                    </fieldset>
                );
            })}
        </div>
    );
}
