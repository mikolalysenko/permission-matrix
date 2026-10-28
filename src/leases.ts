import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The lease adapter uses real CLI/socket/MCP workers and a recording provider. */
export function runLeaseMatrix(args: string[]): Promise<number> {
  const adapter = fileURLToPath(new URL("../../adapters/agent_leases/main.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [adapter, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 2));
  });
}
