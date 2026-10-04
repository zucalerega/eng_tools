import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionContext, SessionStore } from "./session";
import "./styles.css";
import { StoreContext, VaultStore } from "./vault/store";

// Who's signed in, for both apps; and Vault's index, which App starts on the vault's pages.
const session = new SessionStore();
session.start();
const vault = new VaultStore(session);

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <SessionContext.Provider value={session}>
            <StoreContext.Provider value={vault}>
                <App />
            </StoreContext.Provider>
        </SessionContext.Provider>
    </StrictMode>,
);
