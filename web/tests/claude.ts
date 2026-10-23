import { createServer } from "node:http";

// A stand-in for Anthropic's Messages API, for the questions Help asks Claude: the test server's assistant talks to
// it (YJSP_ANTHROPIC_BASE_URL) as it would to Anthropic. It answers by saying back what it was asked, and how many
// questions the conversation has had, in pieces as Anthropic streams them, with a link into the help. A question with
// [decline] in it is declined, and one with [fail] is turned away, as if Anthropic were overloaded.

interface Asked {
    model: string;
    messages: { role: string; content: string }[];
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
            const text = declined ? "" : answerTo(question, questions.length);
            response.writeHead(200, { "content-type": "text/event-stream" });
            const send = (type: string, data: object) =>
                response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            const usage = {
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 1,
            };
            const message = { id: "msg_test", type: "message", role: "assistant", model: asked.model, content: [] };
            send("message_start", { message: { ...message, stop_reason: null, stop_sequence: null, usage } });
            send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            for (let at = 0; at < text.length; at += 16) {
                send("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(at, at + 16) } });
            }
            send("content_block_stop", { index: 0 });
            const stop = declined ? "refusal" : "end_turn";
            send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } });
            send("message_stop", {});
            response.end();
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
