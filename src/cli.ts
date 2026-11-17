#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { registerApiKeys } from "./commands/api-keys.ts";
import { registerBeats, registerEvents } from "./commands/beats.ts";
import { registerDockerHosts } from "./commands/docker-hosts.ts";
import { registerHousekeeping } from "./commands/housekeeping.ts";
import { registerMaintenance } from "./commands/maintenance.ts";
import { registerMonitors } from "./commands/monitors.ts";
import { registerNotifications } from "./commands/notifications.ts";
import { registerProxies } from "./commands/proxies.ts";
import { registerSettings } from "./commands/settings.ts";
import { registerStatusPages } from "./commands/status-pages.ts";
import { registerTags } from "./commands/tags.ts";
import { disconnect } from "./kuma.ts";
import { CliError } from "./lib.ts";
import { VERSION } from "./version.ts";

function buildProgram(): Command {
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
  registerDockerHosts(program);
  registerTags(program);
  registerMaintenance(program);
  registerStatusPages(program);
  registerSettings(program);
  registerApiKeys(program);
  registerHousekeeping(program);

  return program;
}

// Runs one invocation and returns its exit code. The program is rebuilt per
// call so repeated invocations in one process (the unit tests) start clean.
export async function runCli(args: string[]): Promise<number> {
  let exitCode = 0;
  try {
    await buildProgram().parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof CliError) {
      if (err.message) console.error(err.message);
      exitCode = err.exitCode;
    } else if (err instanceof CommanderError) {
      // commander.help is the missing-subcommand path: help already went to
      // stderr via help({error:true}), so it maps to a usage error (2).
      exitCode = err.code === "commander.version" || err.code === "commander.helpDisplayed" ? 0 : 2;
    } else {
      console.error(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = 70;
    }
  } finally {
    disconnect();
  }
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
