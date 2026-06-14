#!/usr/bin/env node

import { anthropic, runServer } from "./api";
import { program } from "commander";
import { VERSION } from "./version";

program
  .name("fuseproxy")
  .description(
    "CLI to run a Langfuse-instrumented proxy for Anthropic's Message API (and compatible providers)",
  )
  .version(VERSION);

program
  .command("run")
  .description(
    "Run the server, optionally specifiying the Anthropic API key and base URL.",
  )
  .option(
    "-k, --key <string>",
    "API key for Anthropic (or compatible provider)",
    undefined,
  )
  .option(
    "-u, --url <string>",
    "Base URL for Anthropic (or compatible provider)",
    undefined,
  )
  .option(
    "-p, --port <number>",
    "Port on which to serve the FuseProxy server",
    undefined,
  )
  .action(async (options) => {
    if (options.key) {
      anthropic.apiKey = options.key;
    }
    if (options.url) {
      anthropic.baseURL = options.url;
    }
    let port: undefined | number = undefined;
    if (options.port) {
      port = parseInt(options.port);
    }
    try {
      await runServer(port);
    } catch (e) {
      console.error(e);
    }
  });

program.parseAsync();
