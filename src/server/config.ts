import path from "node:path";
import { workspaceStateRoot } from "montane-code";

export interface AppConfig {
  port: number;
  workspaceRoot: string;
  stateRoot: string;
  databasePath: string;
  exportRoot: string;
}

export function loadConfig(): AppConfig {
  const workspaceRoot = path.resolve(process.env.INSIGHTFLOW_WORKSPACE ?? process.cwd());
  const stateRoot = workspaceStateRoot(workspaceRoot);

  return {
    port: Number(process.env.PORT ?? 4310),
    workspaceRoot,
    stateRoot,
    databasePath: path.join(stateRoot, "data-agent", "ontology.sqlite"),
    exportRoot: path.join(stateRoot, "data-agent", "exports"),
  };
}
