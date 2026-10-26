import { fireEvent } from "@testing-library/react";

// Dragging something onto a folder, as a mouse does: Yorg's views, scripts, and Piper's diagrams.

/** What a drag carries, as a browser would (jsdom has none). */
export function dataTransfer() {
    const data: Record<string, string> = {};
    const types: string[] = [];
    return {
        types,
        dropEffect: "none",
        effectAllowed: "all",
        setData(type: string, value: string) {
            data[type] = value;
            types.push(type);
        },
        getData: (type: string) => data[type] ?? "",
    };
}

/** Drag one thing onto another, as a mouse would. */
export function drag(what: Element, onto: () => Element) {
    const transfer = dataTransfer();
    fireEvent.dragStart(what, { dataTransfer: transfer });
    fireEvent.dragOver(onto(), { dataTransfer: transfer });
    fireEvent.drop(onto(), { dataTransfer: transfer });
    fireEvent.dragEnd(what, { dataTransfer: transfer });
}
