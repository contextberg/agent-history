import { printBanner } from './banner.js';
import { startMcpServer } from './mcp/server.js';
import { startWebServer } from './server/index.js';
import { runSetup, runStatus, runUninstall } from './setup/index.js';
import { runTest } from './setup/test-call.js';
import { runLearn } from './knowledge/index.js';
import { showPrompt } from './setup/show-prompt.js';

const args = process.argv.slice(2);
// Treat a leading flag (`--dev`, `--mcp`, `--help`) as "no subcommand" - the
// flag itself is consumed below. Without this, invocations like
// `tsx watch src/cli.ts --dev` would land in the `default:` arm and exit 1
// with "Unknown command: --dev".
const command = args[0]?.startsWith('-') ? undefined : args[0];

// Mode flags can appear before or after subcommands; check globally.
const isMcp = args.includes('--mcp');
const isDev = args.includes('--dev');
const wantsHelp = args.includes('--help') || args.includes('-h');

async function main(): Promise<void> {
  // Mode flags take precedence over subcommands so `contextberg --mcp` is
  // the canonical MCP entry point even though we don't ship an `mcp`
  // subcommand.
  if (isMcp) {
    await startMcpServer();
    return;
  }

  switch (command) {
    case 'setup':
      await runSetup();
      break;

    case 'learn': {
      const commitFlag = args.indexOf('--commit');
      const repoFlag = args.indexOf('--repo');
      const verbose = args.includes('--verbose') || args.includes('-v');
      const learnOpts: Parameters<typeof runLearn>[0] = { verbose };
      const commitArg = commitFlag !== -1 ? args[commitFlag + 1] : undefined;
      const repoArg = repoFlag !== -1 ? args[repoFlag + 1] : undefined;
      if (commitArg) learnOpts.commit = commitArg;
      if (repoArg) learnOpts.repo = repoArg;
      const result = await runLearn(learnOpts);
      // CLI exit policy: keep behavior identical to the prior `process.exit`-
      // based version. `error` and `no-auth` are real config / runtime
      // failures and exit non-zero; everything else (ok / skip / no-sessions /
      // empty) is normal flow and exits 0.
      if (result.status === 'error' || result.status === 'no-auth') {
        process.exit(1);
      }
      break;
    }

    case 'status':
      await runStatus();
      break;

    case 'test':
      await runTest();
      break;

    case 'show-prompt':
      await showPrompt();
      break;

    case 'uninstall':
      await runUninstall();
      break;

    case 'help':
    case undefined:
      if (wantsHelp || command === 'help') {
        printHelp();
        return;
      }
      // Bare `contextberg` (no subcommand, no help flag) launches the
      // browser viewer. This is the default "open it up" command - symmetric
      // with `agent-history` so users only need to remember one binary name.
      printBanner();
      await startWebServer(buildWebServerOptions());
      break;

    default:
      if (wantsHelp) {
        printHelp();
        return;
      }
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function readPortEnv(): number | undefined {
  const raw = process.env['AGENT_HISTORY_API_PORT'];
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function buildWebServerOptions(): { isDev: boolean; port?: number } {
  const port = readPortEnv();
  return port === undefined ? { isDev } : { isDev, port };
}

function printHelp(): void {
  console.log(`contextberg - AI agent history viewer + cross-agent dreaming

Usage:
  contextberg                    Launch the browser viewer (default action)
  contextberg --mcp              Run as an MCP stdio server
  contextberg setup              Interactive setup: configure model + install git hook
  contextberg learn              Extract knowledge from HEAD (run manually or via hook)
  contextberg learn --commit <ref>  Extract knowledge from a specific commit
  contextberg learn --repo <path>   Specify repo path (default: cwd)
  contextberg status             Show current configuration and hook status
  contextberg test               Send a one-shot prompt to verify provider auth
  contextberg show-prompt        Print the system prompt the LLM will receive
  contextberg uninstall          Remove the post-commit hook from this repo
  contextberg --help             Show this help

Aliases: \`agent-history\` is identical to \`contextberg\` for every command above.
`);
}

main().catch((err) => {
  console.error('[contextberg]', err instanceof Error ? err.message : err);
  process.exit(1);
});
