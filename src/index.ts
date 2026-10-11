import { main } from "./application";
import { safeErrorDescription } from "./logger";

export { main } from "./application";

export const runEntrypoint = async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "fatal", error: safeErrorDescription(error) }));
    process.exitCode = 1;
  }
};

if (import.meta.main) void runEntrypoint();
