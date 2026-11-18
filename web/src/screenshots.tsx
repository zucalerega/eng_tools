import { useRef, useState, type ClipboardEvent } from "react";

// Screenshots people add, in Help, to a question for Claude or to a bug report (assistant.py and feedback.py on the
// server): pasted (Ctrl+V, after Windows' Win+Shift+S or a Mac's Cmd+Shift+Ctrl+4) or picked from a file. Each is
// made smaller here first if it's bigger than it needs to be, so it goes as a PNG or a JPEG the server takes: for
// Claude, to about 1,568 pixels on its longest side, as Anthropic suggests, so it costs fewer tokens; for a person
// reading a bug report, to more.

/** A screenshot, ready to send: a PNG or a JPEG, as base64. */
export interface Screenshot {
    data: string;
    type: "image/png" | "image/jpeg";
    width: number; // in pixels
    height: number;
}

/** The longest side of a screenshot for Claude, and for a person reading a bug report, in pixels. */
export const FOR_CLAUDE = 1568;
export const FOR_PEOPLE = 2560;
// The most a screenshot may be, in bytes: the server's (assistant.MOST_SCREENSHOT).
const MOST_BYTES = 3 << 20;

/** A screenshot as a picture to show: a data: URI. */
export const screenshotSrc = (shot: Screenshot) => `data:${shot.type};base64,${shot.data}`;

/** A PNG's or a JPEG's type and size, from its header; null if it's neither. */
function measure(bytes: Uint8Array): Pick<Screenshot, "type" | "width" | "height"> | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length >= 24 && png.every((byte, index) => bytes[index] === byte)) {
        return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }
    let at = 2;
    while (at + 9 <= bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1]!;
        if (marker === 0xff) {
            at += 1;
        } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2;
        } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { type: "image/jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        } else if (marker === 0xda) {
            return null;
        } else {
            at += 2 + view.getUint16(at + 2);
        }
    }
    return null;
}

function base64(bytes: Uint8Array): string {
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
}

/** A picture drawn again, at most `longest` pixels on a side: a PNG, or a JPEG if a PNG of it is too big. */
async function redraw(file: Blob, longest: number): Promise<Screenshot> {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
        throw new Error("This browser can't make that picture smaller: save it as a smaller PNG or JPEG, then add it");
    }
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error("That isn't a picture: add a screenshot, or a PNG or a JPEG");
    }
    const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("This browser can't make that picture smaller: save it as a smaller PNG or JPEG, then add it");
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: Screenshot["type"]) =>
        new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    for (const type of ["image/png", "image/jpeg"] as const) {
        const blob = await encode(type);
        if (blob && blob.size <= MOST_BYTES) {
            const data = base64(new Uint8Array(await blob.arrayBuffer()));
            return { data, type, width: canvas.width, height: canvas.height };
        }
    }
    throw new Error("That picture is too big to send, even made smaller: crop it, then add it");
}

/** A picture, ready to send: as it is if it's a PNG or a JPEG small enough, else drawn again smaller. */
export async function readScreenshot(file: Blob, longest: number): Promise<Screenshot> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const found = measure(bytes);
    if (found && Math.max(found.width, found.height) <= longest && bytes.length <= MOST_BYTES) {
        return { ...found, data: base64(bytes) };
    }
    return redraw(file, longest);
}

/** The pictures pasted, if any: a screenshot on the clipboard, or picture files copied. */
export function pastedPictures(event: ClipboardEvent): File[] {
    return Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
}

/** Screenshots being added to something: up to `most`, each made no bigger than `longest` pixels on a side. */
export function useScreenshots(most: number, longest: number) {
    const [shots, setShots] = useState<Screenshot[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const count = useRef(0); // as added, before the state shows them
    count.current = shots.length;

    async function add(files: File[]): Promise<void> {
        setProblem(null);
        for (const file of files) {
            if (count.current >= most) {
                setProblem(`You can add up to ${most} screenshots`);
                return;
            }
            try {
                const shot = await readScreenshot(file, longest);
                count.current += 1;
                setShots((now) => [...now, shot]);
            } catch (error) {
                setProblem((error as Error).message);
                return;
            }
        }
    }
    return {
        shots,
        problem,
        add,
        remove: (at: number) => setShots((now) => now.filter((_, index) => index !== at)),
        clear: () => {
            setShots([]);
            setProblem(null);
        },
    };
}

/** A paperclip. */
function ClipIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
                d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.1 8.1a1.8 1.8 0 0 1-2.6-2.6l7.4-7.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** A button that picks pictures to add: with a paperclip and no words (`compact`), or saying what it does. */
export function AddScreenshots({
    onPick,
    disabled,
    compact,
}: {
    onPick: (files: File[]) => void;
    disabled?: boolean;
    compact?: boolean;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <button
                type="button"
                className={compact ? "screenshot-add-icon" : "button-small"}
                aria-label="Add a screenshot"
                title="Add a screenshot (or paste one)"
                disabled={disabled}
                onClick={() => input.current?.click()}
            >
                {compact ? <ClipIcon /> : "Add a screenshot"}
            </button>
            <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/*"
                multiple
                hidden
                data-testid="screenshot-file"
                onChange={(event) => {
                    onPick(Array.from(event.target.files ?? []));
                    event.target.value = ""; // the same file again is picked again
                }}
            />
        </>
    );
}

/**
 * Screenshots shown small, each on the server opening full size; with a button to take each one off, given
 * `onRemove`.
 */
export function ScreenshotStrip({
    sources,
    onRemove,
    label = "Screenshots",
}: {
    sources: string[];
    onRemove?: (at: number) => void;
    label?: string;
}) {
    if (sources.length === 0) {
        return null;
    }
    return (
        <ul className="screenshot-strip" aria-label={label}>
            {sources.map((src, at) => (
                <li key={at}>
                    {src.startsWith("data:") ? (
                        // Not yet on the server: a browser won't open a data: address in a tab of its own.
                        <img src={src} alt={`Screenshot ${at + 1}`} />
                    ) : (
                        <a href={src} target="_blank" rel="noreferrer" title="Open it full size">
                            <img src={src} alt={`Screenshot ${at + 1}`} />
                        </a>
                    )}
                    {onRemove && (
                        <button
                            type="button"
                            className="screenshot-remove"
                            aria-label={`Remove screenshot ${at + 1}`}
                            onClick={() => onRemove(at)}
                        >
                            ×
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}
