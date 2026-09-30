import type { ReactNode } from "react";

// A text cell's Markdown, shown: headings, paragraphs, lists, quotes, code, rules, bold, italics, and links. It's made
// of React's elements, never HTML from the text, so a notebook can put nothing on the page but what it says; and links
// go only to the web (http, https), mail, or the site's own pages.

const SAFE_LINK = /^(https?:|mailto:|\/(?!\/))/i;

// The first of what's marked in a line: code, bold, italics, or a link.
const INLINE =
    /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|\b_([^_\s][^_]*?)_\b|\[([^\]]+)\]\(([^)\s]+)\)/;

/** A line's text, with its marks shown. */
function inline(text: string, key = "i"): ReactNode[] {
    const found: ReactNode[] = [];
    let rest = text;
    let index = 0;
    while (rest) {
        const match = INLINE.exec(rest);
        if (!match) {
            found.push(rest);
            break;
        }
        if (match.index > 0) {
            found.push(rest.slice(0, match.index));
        }
        const at = `${key}-${index}`;
        index += 1;
        const [whole, , code, bold, boldToo, italic, italicToo, label, href] = match;
        if (code !== undefined) {
            found.push(<code key={at}>{code}</code>);
        } else if (bold !== undefined || boldToo !== undefined) {
            found.push(<strong key={at}>{inline(bold ?? boldToo!, at)}</strong>);
        } else if (italic !== undefined || italicToo !== undefined) {
            found.push(<em key={at}>{inline(italic ?? italicToo!, at)}</em>);
        } else if (label !== undefined && href !== undefined) {
            found.push(
                SAFE_LINK.test(href) ? (
                    <a key={at} href={href} target="_blank" rel="noreferrer">
                        {inline(label, at)}
                    </a>
                ) : (
                    <span key={at}>{inline(label, at)}</span>
                ),
            );
        }
        rest = rest.slice(match.index + whole.length);
    }
    return found;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```/;

/** Markdown's blocks, each shown. */
function blocks(lines: string[], key = "b"): ReactNode[] {
    const found: ReactNode[] = [];
    let at = 0;
    const next = () => `${key}-${found.length}`;
    while (at < lines.length) {
        const line = lines[at]!;
        if (!line.trim()) {
            at += 1;
            continue;
        }
        if (FENCE.test(line)) {
            const code: string[] = [];
            at += 1;
            while (at < lines.length && !FENCE.test(lines[at]!)) {
                code.push(lines[at]!);
                at += 1;
            }
            at += 1; // the closing fence
            found.push(
                <pre key={next()}>
                    <code>{code.join("\n")}</code>
                </pre>,
            );
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            // The page has the h1: a cell's headings start under it.
            const level = Math.min(heading[1]!.length + 1, 6);
            const Heading = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
            found.push(<Heading key={next()}>{inline(heading[2]!, next())}</Heading>);
            at += 1;
            continue;
        }
        if (RULE.test(line)) {
            found.push(<hr key={next()} />);
            at += 1;
            continue;
        }
        if (QUOTE.test(line)) {
            const quoted: string[] = [];
            while (at < lines.length && QUOTE.test(lines[at]!)) {
                quoted.push(QUOTE.exec(lines[at]!)![1]!);
                at += 1;
            }
            found.push(<blockquote key={next()}>{blocks(quoted, next())}</blockquote>);
            continue;
        }
        const listed = BULLET.test(line)
            ? { pattern: BULLET, List: "ul" as const }
            : NUMBERED.test(line)
              ? { pattern: NUMBERED, List: "ol" as const }
              : null;
        if (listed) {
            const items: string[] = [];
            while (at < lines.length && listed.pattern.test(lines[at]!)) {
                items.push(listed.pattern.exec(lines[at]!)![1]!);
                at += 1;
            }
            const list = next();
            const List = listed.List;
            found.push(
                <List key={list}>
                    {items.map((item, index) => (
                        <li key={index}>{inline(item, `${list}-${index}`)}</li>
                    ))}
                </List>,
            );
        } else {
            // A paragraph: its lines up to a blank one or another block.
            const paragraph: string[] = [];
            while (
                at < lines.length &&
                lines[at]!.trim() &&
                !FENCE.test(lines[at]!) &&
                !HEADING.test(lines[at]!) &&
                !RULE.test(lines[at]!) &&
                !QUOTE.test(lines[at]!) &&
                !BULLET.test(lines[at]!) &&
                !NUMBERED.test(lines[at]!)
            ) {
                paragraph.push(lines[at]!.trim());
                at += 1;
            }
            found.push(<p key={next()}>{inline(paragraph.join(" "), next())}</p>);
        }
    }
    return found;
}

/** A text cell's Markdown, shown. */
export function Markdown({ source }: { source: string }) {
    return <div className="markdown">{blocks(source.split("\n"))}</div>;
}
