import { createServer } from "node:http";

// A stand-in for eBay's Browse API, for the deals finder: the test server searches it (YJSP_EBAY_BASE_URL) as it would
// eBay. It gives a token to any keyset, and finds a listing only for a test's part numbers (QA-1234), so no other
// test's components get deals: four listings of the part, two of them well under the typical price (the median of the
// four, $60 shipped), which a check finds as they were.

export const EBAY_CLIENT = { id: "YJSP-test-PRD-web", secret: "PRD-web-secret" };

function listing(id: string, title: string, price: string, shipping: string | null) {
    return {
        itemId: id,
        title,
        price: { value: price, currency: "USD" },
        condition: "Used",
        itemWebUrl: `https://www.ebay.com/itm/${id.split("|")[1]}`,
        buyingOptions: ["FIXED_PRICE"],
        shippingOptions:
            shipping === null
                ? [{ shippingCostType: "CALCULATED" }]
                : [{ shippingCostType: "FIXED", shippingCost: { value: shipping, currency: "USD" } }],
    };
}

/** What the stand-in has for a search: four listings of the part a test asked for, or nothing. */
function results(query: string) {
    const number = /\bQA-\d+\b/.exec(query)?.[0];
    if (!number) {
        return [];
    }
    const digits = number.slice(3);
    return [
        listing(`v1|9${digits}1|0`, `Swagelok ${number} Stainless Ball Valve 1/4 in`, "40.00", "5.00"),
        listing(`v1|9${digits}2|0`, `${number} ball valve, 1/4 in, stainless`, "50.00", null),
        listing(`v1|9${digits}3|0`, `NEW ${number} Swagelok 1/4 in ball valve`, "62.00", "8.00"),
        listing(`v1|9${digits}4|0`, `${number} Swagelok valve, new old stock`, "80.00", "0.00"),
    ];
}

export function fakeEbay(): Promise<{ url: string; close: () => void }> {
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            const address = new URL(request.url ?? "/", "http://ebay.test");
            const send = (status: number, payload: unknown) => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(payload));
            };
            if (request.method === "POST" && address.pathname === "/identity/v1/oauth2/token") {
                return send(200, {
                    access_token: "web-token",
                    expires_in: 7200,
                    token_type: "Application Access Token",
                });
            }
            if (address.pathname === "/buy/browse/v1/item_summary/search") {
                const found = results(address.searchParams.get("q") ?? "");
                return send(200, { total: found.length, itemSummaries: found });
            }
            if (address.pathname.startsWith("/buy/browse/v1/item/")) {
                const id = decodeURIComponent(address.pathname.slice("/buy/browse/v1/item/".length));
                const number = /^v1\|9(\d+)\d\|0$/.exec(id)?.[1];
                const found = number ? results(`QA-${number}`).find((each) => each.itemId === id) : undefined;
                return found ? send(200, found) : send(404, { errors: [{ errorId: 11001, message: "Not found" }] });
            }
            send(404, { errors: [{ errorId: 404, message: "No such resource" }] });
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
