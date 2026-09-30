import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";

// The Python window's notebook, as the tests use it: a cell by its number, and its editor (CodeMirror), whose code is
// set and read through CodeMirror itself (jsdom can't type into it as a browser would), and keys pressed in it.

/** A cell of the notebook, by its number (from 1). */
export const cell = (number: number): HTMLElement =>
    screen.getByRole("region", { name: new RegExp(`^Cell ${number}(:.*)?$`) });

/** How many cells the notebook has. */
export const cellCount = (): number => screen.queryAllByRole("region", { name: /^Cell \d+(:.*)?$/ }).length;

/** A cell's editor, once it's on the page. */
export async function editorOf(number: number): Promise<EditorView> {
    const region = await screen.findByRole("region", { name: new RegExp(`^Cell ${number}(:.*)?$`) });
    const content = await within(region).findByRole("textbox", { name: /: (code|text)$/ }); // not its title's box
    const view = EditorView.findFromDOM(content);
    if (!view) {
        throw new Error(`Cell ${number} has no editor`);
    }
    return view;
}

/** A cell's code (or text). */
export const codeOf = async (number: number): Promise<string> => (await editorOf(number)).state.doc.toString();

/** Put code in a cell, all of it. */
export async function setCode(number: number, code: string): Promise<void> {
    const view = await editorOf(number);
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } }));
}

/** Type in a cell at its cursor (the end, unless put elsewhere), as typing does: suggestions follow it. */
export async function typeIn(number: number, text: string): Promise<void> {
    const view = await editorOf(number);
    act(() => {
        view.focus();
        const at = view.state.selection.main.head;
        view.dispatch({
            changes: { from: at, insert: text },
            selection: { anchor: at + text.length },
            userEvent: "input.type",
        });
    });
}

/** Put a cell's cursor at the end of its code. */
export async function toEnd(number: number): Promise<void> {
    const view = await editorOf(number);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
}

/** Press a key in a cell's editor: "Enter", with shift, say. */
export async function press(
    number: number,
    key: string,
    modifiers: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {},
): Promise<void> {
    const view = await editorOf(number);
    act(() => {
        fireEvent.keyDown(view.contentDOM, { key, ...modifiers });
    });
}

/**
 * Take the suggestion picked in a cell's list with Enter, as a person would: once the list has been up long enough to
 * take keys (CodeMirror ignores them for 75 ms after it opens, so fast typing doesn't take one by mistake), which the
 * clock is moved on for rather than waited for.
 */
export async function acceptSuggestion(number: number): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        vi.setSystemTime(Date.now() + 100);
        await press(number, "Enter");
    } finally {
        vi.useRealTimers();
    }
}
