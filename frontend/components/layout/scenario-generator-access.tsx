import { getCurrentMember } from "@/lib/auth-server";
import ScenarioGenerator from "./scenario-generator";

export default async function ScenarioGeneratorAccess() {
  const result = await getCurrentMember();
  if (!result.ok || result.data.role !== "ADMIN") return null;
  return <ScenarioGenerator key={result.data.id} operatorId={result.data.id} />;
}
