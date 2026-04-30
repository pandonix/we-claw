#!/usr/bin/env node
import { startWeClawServer } from "./server.js";

const command = process.argv[2] ?? "start";

if (command !== "start") {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: we-claw start");
  process.exit(1);
}

const server = await startWeClawServer();
console.log(`We-Claw is running at ${server.url}`);
console.log("Press Ctrl+C to stop the local server.");
