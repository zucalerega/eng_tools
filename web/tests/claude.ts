import { createServer } from "node:http";

// A stand-in for Anthropic's Messages API, for the questions Help asks Claude: the test server's assistant talks to
// it (YJSP_ANTHROPIC_BASE_URL) as it would to Anthropic. It answers by saying back what it was asked, and how many
// questions the conversation has had, in pieces as Anthropic streams them, with a link into the help. A question with
// [decline] in it is declined, one with [fail] is turned away as if Anthropic were overloaded, one with [slow] is
// answered a piece every fifth of a second, for a few seconds, and one with [long] at length (about 30,000 characters).
// A request that doesn't stream, as the server's to keep the help ready, gets the whole of an empty answer.

interface Asked {
    model: string;
    messages: { role: string; content: string }[];
    stream?: boolean;
}

function answerTo(question: string, number: number): string {
    return `You asked: "${question}" (question ${number} here). See [Conflicts](/help#solidworks-conflicts).`;
}

export function fakeClaude(): Promise<{ url: string; close: () => void }> {
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            const asked = JSON.parse(body) as Asked;
            if (!asked.stream) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        id: "msg_test",
                        type: "message",
                        role: "assistant",
                        model: asked.model,
                        content: [],
                        stop_reason: "max_tokens",
                        stop_sequence: null,
                        usage: {
                            input_tokens: 10,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 1000,
                            output_tokens: 0,
                        },
                    }),
                );
                return;
            }
            const questions = asked.messages.filter((message) => message.role === "user");
            const question = questions.at(-1)!.content.replace(/^\[Asked from [^\]]*\]\n\n/, "");
            if (question.includes("[fail]")) {
                response.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
                response.end(
                    JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
                );
                return;
            }
            const declined = question.includes("[decline]");
            let text = declined ? "" : answerTo(question, questions.length);
            if (question.includes("[long]")) {
                text += "\n\n" + "And there's more to it. ".repeat(1250);
            }
            if (question.includes("[slow]")) {
                text += " And then" + " some more".repeat(30) + ".";
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            let gone = false; // the server stopped the answer
            response.on("close", () => (gone = true));
            const send = (type: string, data: object) =>
                gone || response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            const usage = {
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 1,
            };
            const message = { id: "msg_test", type: "message", role: "assistant", model: asked.model, content: [] };
            send("message_start", { message: { ...message, stop_reason: null, stop_sequence: null, usage } });
            send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            const pieces: string[] = [];
            for (let at = 0; at < text.length; at += 16) {
                pieces.push(text.slice(at, at + 16));
            }
            const piece = (words: string) =>
                send("content_block_delta", { index: 0, delta: { type: "text_delta", text: words } });
            const end = () => {
                send("content_block_stop", { index: 0 });
                const stop = declined ? "refusal" : "end_turn";
                send("message_delta", {
                    delta: { stop_reason: stop, stop_sequence: null },
                    usage: { output_tokens: 50 },
                });
                send("message_stop", {});
                response.end();
            };
            if (!question.includes("[slow]")) {
                pieces.forEach(piece);
                end();
                return;
            }
            const next = () => {
                if (gone) {
                    return;
                }
                const words = pieces.shift();
                if (words === undefined) {
                    end();
                } else {
                    piece(words);
                    setTimeout(next, 200);
                }
            };
            next();
        });
    });
    return new Promise((done) =>
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            done({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
        }),
    );
}
