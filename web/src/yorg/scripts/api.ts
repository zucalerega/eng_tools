import { request } from "../../api";

// Yorg's saved scripts (/api/yorg/scripts, for admins while the Python window is tried out): each with a name and a
// folder ("Hotfires/Injector"; "" for none).

export interface Script {
    id: string;
    name: string;
    folder: string;
    code?: string; // not in a listing
    datasets?: number[]; // the tests it works on, the first first
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
}

export const scriptsApi = {
    list: () => request<Script[]>("GET", "/api/yorg/scripts"),
    get: (id: string) => request<Script>("GET", `/api/yorg/scripts/${id}`),
    add: (name: string, folder: string, code: string, datasets: number[] = []) =>
        request<Script>("POST", "/api/yorg/scripts", { name, folder, code, datasets }),
    save: (id: string, name: string, folder: string, code: string, datasets: number[] = []) =>
        request<Script>("PUT", `/api/yorg/scripts/${id}`, { name, folder, code, datasets }),
    remove: (id: string) => request<void>("DELETE", `/api/yorg/scripts/${id}`),
};
