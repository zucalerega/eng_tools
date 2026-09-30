import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// The code editor in Yorg's colors: its surface, text, accent, and borders are the site's (styles.css), light or dark
// as the site is, and Python's parts have colors of their own (--code-* in scripts.css): keywords in the site's blue,
// or its gold when it's dark.

export const editorTheme = EditorView.theme({
    "&": {
        color: "var(--text)",
        backgroundColor: "var(--surface)",
        fontSize: "13px",
    },
    "&.cm-focused": {
        outline: "none",
    },
    ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
    },
    ".cm-content": {
        caretColor: "var(--accent)",
        padding: "6px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--accent)",
        borderLeftWidth: "2px",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
            backgroundColor: "var(--code-selection)",
        },
    ".cm-activeLine": {
        backgroundColor: "var(--code-active-line)",
    },
    ".cm-gutters": {
        backgroundColor: "var(--surface)",
        color: "var(--muted)",
        border: "none",
        borderRight: "1px solid var(--border)",
    },
    ".cm-activeLineGutter": {
        backgroundColor: "var(--code-active-line)",
        color: "var(--text)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 6px 0 8px",
        minWidth: "2.2em",
    },
    ".cm-foldGutter .cm-gutterElement": {
        padding: "0 2px",
        color: "var(--muted)",
    },
    ".cm-foldPlaceholder": {
        backgroundColor: "var(--accent-soft)",
        border: "1px solid var(--border-strong)",
        color: "var(--muted)",
        borderRadius: "4px",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "var(--code-bracket)",
        outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
    },
    ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "var(--danger-soft)",
    },
    ".cm-selectionMatch": {
        backgroundColor: "var(--code-match)",
    },
    ".cm-searchMatch": {
        backgroundColor: "var(--code-search)",
        outline: "1px solid color-mix(in srgb, var(--gold) 55%, transparent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--gold) 45%, transparent)",
    },
    ".cm-placeholder": {
        color: "var(--muted)",
        fontStyle: "italic",
    },
    ".cm-panels": {
        backgroundColor: "var(--surface-2)",
        color: "var(--text)",
    },
    ".cm-panels.cm-panels-top": {
        borderBottom: "1px solid var(--border)",
    },
    ".cm-panels.cm-panels-bottom": {
        borderTop: "1px solid var(--border)",
    },
    ".cm-panel.cm-search": {
        padding: "6px 8px",
        fontFamily: "inherit",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        fontSize: "12.5px",
    },
    ".cm-tooltip": {
        backgroundColor: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-pop)",
        overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
        maxHeight: "16em",
    },
    ".cm-tooltip-autocomplete > ul > li": {
        padding: "2px 8px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--accent)",
    },
    ".cm-completionDetail": {
        color: "var(--muted)",
        fontStyle: "normal",
        marginLeft: "1em",
    },
    ".cm-completionMatchedText": {
        textDecoration: "none",
        fontWeight: "700",
    },
    ".cm-diagnostic": {
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
    },
    ".cm-diagnostic-error": {
        borderLeftColor: "var(--danger)",
    },
    ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy var(--danger)",
        textUnderlineOffset: "3px",
    },
    ".cm-lintPoint-error:after": {
        borderBottomColor: "var(--danger)",
    },
});

/** Python's parts, colored (the colors are scripts.css's --code-* variables). */
export const codeHighlight = HighlightStyle.define([
    {
        tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword],
        color: "var(--code-keyword)",
        fontWeight: "600",
    },
    { tag: tags.modifier, color: "var(--code-keyword)" },
    { tag: [tags.string, tags.special(tags.string)], color: "var(--code-string)" },
    { tag: [tags.escape, tags.number, tags.bool, tags.null], color: "var(--code-number)" },
    { tag: [tags.comment, tags.lineComment], color: "var(--code-comment)", fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--code-function)" },
    {
        tag: [tags.function(tags.definition(tags.variableName)), tags.definition(tags.className), tags.className],
        color: "var(--code-definition)",
        fontWeight: "600",
    },
    { tag: [tags.self, tags.standard(tags.variableName)], color: "var(--code-builtin)" },
    { tag: tags.propertyName, color: "var(--code-property)" },
    { tag: tags.meta, color: "var(--code-decorator)" },
    {
        tag: [tags.operator, tags.derefOperator, tags.punctuation, tags.separator, tags.paren, tags.squareBracket],
        color: "var(--code-punctuation)",
    },
    { tag: tags.brace, color: "var(--code-punctuation)" },
    { tag: tags.invalid, color: "var(--danger)" },
    // Markdown, in a text cell being edited.
    { tag: tags.heading, color: "var(--heading)", fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.link, color: "var(--accent)" },
]);
