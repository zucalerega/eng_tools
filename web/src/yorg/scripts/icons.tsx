import type { ReactNode } from "react";

// The Python window's icons: line drawings in the text's colour, for the buttons that say what they do in their
// label (aria-label) and tooltip (title) rather than in words.

const DRAWINGS = {
    play: <path d="M5 3.2v9.6l7.6-4.8z" fill="currentColor" stroke="none" />,
    plus: <path d="M8 3v10M3 8h10" />,
    upload: <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v3h11v-3" />,
    download: <path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10v3h11v-3" />,
    trash: <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9M6.7 7v4M9.3 7v4" />,
    restart: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3.2H9.8" />,
    keyboard: (
        <>
            <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
            <path d="M4.3 6.8h.01M6.8 6.8h.01M9.3 6.8h.01M11.8 6.8h.01M5 9.8h6" />
        </>
    ),
    book: (
        <path d="M8 4.3C6.4 3.2 4.4 2.9 2 3.2v9.3c2.4-.3 4.4 0 6 1.1 1.6-1.1 3.6-1.4 6-1.1V3.2c-2.4-.3-4.4 0-6 1.1zM8 4.3v9.3" />
    ),
    external: <path d="M9.5 2.5h4v4M13.5 2.5l-6 6M11.5 9.5v4h-9v-9h4" />,
    close: <path d="M4 4l8 8M12 4l-8 8" />,
    folder: <path d="M1.8 4.2v8.3c0 .6.4 1 1 1h10.4c.6 0 1-.4 1-1V6c0-.6-.4-1-1-1H7.6L6.1 3.2H2.8c-.6 0-1 .4-1 1z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof DRAWINGS;

export function Icon({ name }: { name: IconName }) {
    return (
        <svg
            className="icon"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {DRAWINGS[name]}
        </svg>
    );
}
