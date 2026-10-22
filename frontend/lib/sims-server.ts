import "server-only";
import { request } from "./orders-server";
import type { SimProfile } from "./issuance";

export function getSims() { return request<SimProfile[]>("/api/sims"); }
export function getSim(id: string) { return request<SimProfile>(`/api/sims/${encodeURIComponent(id)}`); }
