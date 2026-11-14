import { Command, CommanderError } from "commander";
import { registerBeats, registerEvents } from "./commands/beats.ts";
import { registerMonitors } from "./commands/monitors.ts";
import { registerNotifications } from "./commands/notifications.ts";
import { registerProxies } from "./commands/proxies.ts";
import { disconnect } from "./kuma.ts";
import { CliError } from "./lib.ts";
import { VERSION } from "./version.ts";

const program = new Command();
program
  .name("uptime-kuma-cli")
  .description("Operate an Uptime Kuma instance from the shell")
  .version(VERSION)
  .exitOverride();

registerMonitors(program);
registerBeats(program);
registerEvents(program);
registerNotifications(program);
registerProxies(program);

let exitCode = 0;
try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CliError) {
    if (err.message) console.error(err.message);
    exitCode = err.exitCode;
  } else if (err instanceof CommanderError) {
    exitCode =
      err.code === "commander.version" ||
      err.code === "commander.help" ||
      err.code === "commander.helpDisplayed"
        ? 0
        : 2;
  } else {
    console.error(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 70;
  }
} finally {
  disconnect();
}
process.exitCode = exitCode;
