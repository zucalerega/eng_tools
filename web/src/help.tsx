import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { type ChatStore, type Exchange, useChat } from "./chat";
import { Notice } from "./components";
import { FeedbackPane } from "./feedback";
import { Markdown } from "./markdown";
import { Link, usePathname } from "./router";

// Help, in the top bar of every app: a panel beside the page with the help (the server's /help, for anyone) and
// Claude, which has read all of it, to ask how to do something or what an error means (chat.ts; assistant.py on the
// server); and Requests, to send the site's owner a bug report or a feature request (feedback.tsx). The page stays as
// it is beside it, error and all.

const SHORT = 90; // of an error's words, on the button that asks about it

/** A question mark in a circle. */
function HelpIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path
                d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.8-1.1 1.5v.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
            <circle cx="12" cy="16.8" r="1.15" fill="currentColor" />
        </svg>
    );
}

export function HelpButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            className="help-button"
            aria-label="Help"
            aria-expanded={open}
            title="Help: the guide, troubleshooting, and asking Claude"
            onClick={onToggle}
        >
            <HelpIcon />
        </button>
    );
}

/** The error the page is showing, if it is: what Help offers to ask about. */
function errorShown(): string | null {
    const alert = document.querySelector("main [role='alert']");
    const words = alert?.textContent?.replace(/\s+/g, " ").trim();
    return words ? words.slice(0, 1000) : null;
}

export function HelpPanel({
    chat,
    more,
    onClose,
}: {
    chat: ChatStore;
    more?: { to: string; label: string }; // the open app's own help, as Yorg's Help page
    onClose: () => void;
}) {
    const { exchanges, assistant, problem } = useChat(chat);
    const pathname = usePathname();
    const [question, setQuestion] = useState("");
    const [tab, setTab] = useState<"ask" | "requests">("ask");
    const [shown] = useState(errorShown); // as it was when Help opened
    const box = useRef<HTMLTextAreaElement>(null);
    const log = useRef<HTMLDivElement>(null);
    const answering = chat.answering;
    const available = assistant?.available ?? false;

    useEffect(() => {
        void chat.refresh();
    }, [chat]);
    useEffect(() => {
        if (tab === "ask") {
            box.current?.focus();
        }
    }, [tab]);
    // As the answer's written, the conversation keeps its end in view.
    useLayoutEffect(() => {
        const at = log.current;
        at?.scrollTo?.({ top: at.scrollHeight });
    }, [exchanges]);

    function ask() {
        if (!question.trim() || answering || !available) {
            return;
        }
        void chat.ask(question, pathname);
        setQuestion("");
    }
    function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
        // Enter asks, and Shift+Enter starts a new line.
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            ask();
        }
    }
    const used = assistant ? Math.round(assistant.day_used * 100) : 0;
    return (
        <aside
            className="help-panel"
            aria-labelledby="help-title"
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    onClose();
                }
            }}
        >
            <div className="help-head">
                <h2 id="help-title">Help</h2>
                {tab === "ask" && exchanges.length > 0 && (
                    <button type="button" className="help-action" onClick={() => chat.clear()}>
                        New conversation
                    </button>
                )}
                <button type="button" className="help-close" aria-label="Close help" onClick={onClose}>
                    ×
                </button>
            </div>
            <p className="help-links">
                <a href="/help" target="_blank" rel="noreferrer">
                    The guide and troubleshooting
                </a>
                {more && (
                    <>
                        {" · "}
                        <Link to={more.to}>{more.label}</Link>
                    </>
                )}
            </p>
            <div className="segmented help-tabs" role="group" aria-label="Help shows">
                <button type="button" aria-pressed={tab === "ask"} onClick={() => setTab("ask")}>
                    Ask Claude
                </button>
                <button type="button" aria-pressed={tab === "requests"} onClick={() => setTab("requests")}>
                    Report a bug or idea
                </button>
            </div>
            {tab === "requests" ? (
                <FeedbackPane page={pathname} />
            ) : (
                <>
                    <div
                        className="chat-log"
                        ref={log}
                        role="log"
                        aria-label="Conversation with Claude"
                        aria-busy={answering}
                    >
                        {exchanges.length === 0 ? (
                            <div className="chat-welcome">
                                <p>
                                    <strong>Ask Claude</strong> how to do something in Vault, Yorg or Piper, or what an
                                    error means. It has read all of the help, and answers with links to it.
                                </p>
                                {shown && available && (
                                    <button
                                        type="button"
                                        className="chat-suggestion"
                                        onClick={() => {
                                            setQuestion(
                                                `The page says: "${shown}". What does it mean, and what do I do?`,
                                            );
                                            box.current?.focus();
                                        }}
                                    >
                                        Ask about “{shown.length > SHORT ? `${shown.slice(0, SHORT)}…` : shown}”
                                    </button>
                                )}
                            </div>
                        ) : (
                            exchanges.map((exchange, at) => (
                                <ExchangeView key={at} exchange={exchange} again={() => void chat.again(at)} />
                            ))
                        )}
                    </div>
                    {problem && <Notice tone="error">Couldn't ask the server about Claude: {problem}</Notice>}
                    {assistant && !available && <Notice tone="info">{assistant.reason}.</Notice>}
                    {/* One box, the question and its button together; it grows with the question, up to a point. */}
                    <form
                        className="chat-ask"
                        onSubmit={(event) => {
                            event.preventDefault();
                            ask();
                        }}
                    >
                        <textarea
                            ref={box}
                            aria-label="Ask Claude"
                            placeholder="Ask about Vault, Yorg or Piper, or paste an error"
                            rows={2}
                            maxLength={20_000}
                            value={question}
                            disabled={!available}
                            onChange={(event) => setQuestion(event.target.value)}
                            onKeyDown={keys}
                        />
                        {answering ? (
                            <button type="button" className="button-small" onClick={() => chat.stop()}>
                                Stop
                            </button>
                        ) : (
                            <button
                                type="submit"
                                className="button-primary button-small"
                                disabled={!available || !question.trim()}
                            >
                                Ask
                            </button>
                        )}
                    </form>
                    <p className="chat-fine">
                        Claude answers from the help, and can be wrong. Your questions go to Anthropic: never paste a
                        password or a key.
                        {used >= 50 && ` You've used ${used}% of your questions for today.`}
                    </p>
                </>
            )}
        </aside>
    );
}

function ExchangeView({ exchange, again }: { exchange: Exchange; again: () => void }) {
    return (
        <div className="chat-exchange">
            <p className="chat-question">{exchange.question}</p>
            <div className="chat-answer">
                {exchange.state === "thinking" && <p className="chat-thinking">Thinking…</p>}
                {exchange.answer && <Markdown source={exchange.answer} />}
                {exchange.state === "cut" && (
                    <p className="muted">That's as long as an answer gets: ask for the rest if you need it.</p>
                )}
                {exchange.state === "declined" && (
                    <p className="muted">Claude can't help with that one. Ask another way, or ask an admin.</p>
                )}
                {(exchange.state === "stopped" || exchange.state === "failed") && (
                    <div className="chat-again">
                        <p className={exchange.state === "failed" ? "chat-failed" : "muted"}>
                            {exchange.state === "failed" ? exchange.problem : "Stopped."}
                        </p>
                        <button type="button" className="button-small" onClick={again}>
                            Ask again
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
