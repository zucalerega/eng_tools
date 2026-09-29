import { request } from "../../api";

// Yorg's saved scripts (/api/yorg/scripts, for admins while the Python window is tried out): each with a name and a
// folder ("Hotfires/Injector"; "" for none).

export interface Script {
    id: string;
    name: string;
    folder: string;
    code?: string; // not in a listing
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
}

export const scriptsApi = {
    list: () => request<Script[]>("GET", "/api/yorg/scripts"),
    get: (id: string) => request<Script>("GET", `/api/yorg/scripts/${id}`),
    add: (name: string, folder: string, code: string) =>
        request<Script>("POST", "/api/yorg/scripts", { name, folder, code }),
    save: (id: string, name: string, folder: string, code: string) =>
        request<Script>("PUT", `/api/yorg/scripts/${id}`, { name, folder, code }),
    remove: (id: string) => request<void>("DELETE", `/api/yorg/scripts/${id}`),
};
