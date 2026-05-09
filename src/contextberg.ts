import { runSetup, runStatus, runUninstall } from './setup/index.js';
import { runTest } from './setup/test-call.js';
import { runLearn } from './knowledge/index.js';
import { showPrompt } from './setup/show-prompt.js';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
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
      await runLearn(learnOpts);
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

    case undefined:
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`contextberg — AI agent knowledge accumulation

Usage:
  contextberg setup              Interactive setup: configure model and install git hook
  contextberg learn              Extract knowledge from HEAD (run manually or via hook)
  contextberg learn --commit <ref>  Extract knowledge from a specific commit
  contextberg learn --repo <path>   Specify repo path (default: cwd)
  contextberg status             Show current configuration and hook status
  contextberg test               Send a one-shot prompt to verify provider auth
  contextberg show-prompt        Print the system prompt the LLM will receive
  contextberg uninstall          Remove the post-commit hook from this repo
`);
}

main().catch((err) => {
  console.error('[contextberg]', err instanceof Error ? err.message : err);
  process.exit(1);
});
