import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StoreContext, VaultStore } from "./store";
import "./styles.css";

const store = new VaultStore();
store.start();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <StoreContext.Provider value={store}>
            <App />
        </StoreContext.Provider>
    </StrictMode>,
);
