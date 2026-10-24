import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `npm run dev` serves the app at http://localhost:5173 and passes API and sign-in requests, and
// the help (/help, /help.md, /llms.txt), to a YJSP server on port 8000. Sign in on the server first
// (http://localhost:8000): the browser then sends that session to both.
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/api": "http://127.0.0.1:8000",
            "/auth": "http://127.0.0.1:8000",
            "/help": "http://127.0.0.1:8000",
            "/llms.txt": "http://127.0.0.1:8000",
        },
    },
    test: {
        environment: "jsdom",
        // The tests run against the real server (from ../server), like the C# client's tests.
        globalSetup: "./tests/server.ts",
        setupFiles: ["./tests/setup.ts"],
        fileParallelism: false, // one server for all of them: keep what each test sees predictable
        testTimeout: 30_000,
        hookTimeout: 120_000,
    },
});
