import AdminReconciliation from "@/components/screens/admin-reconciliation";

export default async function AdminReconciliationPage({ searchParams }: {
  searchParams: Promise<{ from?: string; to?: string; incident?: string }>;
}) {
  const query = await searchParams;
  const range = typeof query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.from)
    && typeof query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? { from: query.from, to: query.to } : undefined;
  const incident = typeof query.incident === "string" && /^[0-9a-f-]{36}$/i.test(query.incident) ? query.incident : "";
  return <><h1>대사·운영 사건</h1><AdminReconciliation key={`${range?.from}:${range?.to}:${incident}`} initialRange={range} initialIncident={incident} /></>;
}
