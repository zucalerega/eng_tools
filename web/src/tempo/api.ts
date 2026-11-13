import { query, request } from "../api";
import type { TempoEnvironmentRecord, TempoTestDetail, TempoTestSummary, TestEnvironment } from "./types";

export const tempoApi = {
    listTests: (q = "") => request<TempoTestSummary[]>("GET", `/api/tempo/tests${query({ q: q.trim() || undefined })}`),
    getTest: (id: number) => request<TempoTestDetail>("GET", `/api/tempo/tests/${id}`),
    createTest: (body: { name: string; source: string; environment: TestEnvironment }) =>
        request<TempoTestDetail>("POST", "/api/tempo/tests", body),
    updateTest: (
        id: number,
        body: { name: string; source: string; environment: TestEnvironment; expected_version?: number },
    ) => request<TempoTestDetail>("PUT", `/api/tempo/tests/${id}`, body),
    deleteTest: (id: number) => request<void>("DELETE", `/api/tempo/tests/${id}`),

    listEnvironments: (q = "") =>
        request<TempoEnvironmentRecord[]>("GET", `/api/tempo/environments${query({ q: q.trim() || undefined })}`),
    getEnvironment: (id: number) => request<TempoEnvironmentRecord>("GET", `/api/tempo/environments/${id}`),
    createEnvironment: (body: { name: string; description: string; environment: TestEnvironment }) =>
        request<TempoEnvironmentRecord>("POST", "/api/tempo/environments", body),
    updateEnvironment: (
        id: number,
        body: {
            name: string;
            description: string;
            environment: TestEnvironment;
            expected_version?: number;
        },
    ) => request<TempoEnvironmentRecord>("PUT", `/api/tempo/environments/${id}`, body),
    deleteEnvironment: (id: number) => request<void>("DELETE", `/api/tempo/environments/${id}`),
};
