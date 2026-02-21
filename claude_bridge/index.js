const { ClaudeMonitor } = require('./monitor');
const { BridgeIPC } = require('./ipc');

function printUsage() {
  console.log(`Usage: node index.js [options] [-- claude-args...]

Options:
  --claude-cmd <path>    Path to claude CLI (default: claude)
  --bridge-dir <dir>     IPC directory (default: out/claude_bridge)
  --session-id <id>      Session identifier (default: auto-generated)
  --help                 Show this help

Environment:
  CLAUDE_CMD              Same as --claude-cmd
  BRIDGE_DIR              Same as --bridge-dir
  BRIDGE_APPROVAL_TIMEOUT Seconds before auto-reject (default: 300)
  BRIDGE_POLL_INTERVAL    Milliseconds between IPC polls (default: 100)
  BRIDGE_SESSION_ID       Same as --session-id

Examples:
  node index.js -- -p "Fix the bug in src/main.js"
  node index.js --claude-cmd /usr/local/bin/claude -- --continue
  BRIDGE_DIR=/tmp/bridge node index.js -- -p "Implement feature"
`);
}

function main() {
  const args = process.argv.slice(2);

  let claudeCmd;
  let bridgeDir;
  let sessionId;
  let claudeArgs = [];

  const dashIdx = args.indexOf('--');
  const ownArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  claudeArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    switch (ownArgs[i]) {
      case '--claude-cmd':
        claudeCmd = ownArgs[++i];
        break;
      case '--bridge-dir':
        bridgeDir = ownArgs[++i];
        break;
      case '--session-id':
        sessionId = ownArgs[++i];
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        claudeArgs.push(ownArgs[i]);
    }
  }

  if (claudeArgs.length === 0) {
    console.error('[claude_bridge] No Claude CLI arguments provided. Use -- to separate bridge args from claude args.');
    console.error('[claude_bridge] Example: node index.js -- -p "Your prompt here"');
    process.exit(1);
  }

  const ipc = new BridgeIPC(bridgeDir);
  const monitor = new ClaudeMonitor({
    claudeCmd,
    claudeArgs,
    sessionId,
    ipc
  });

  process.on('SIGTERM', () => {
    console.log('[claude_bridge] SIGTERM received — stopping');
    monitor.stop();
  });
  process.on('SIGINT', () => {
    console.log('[claude_bridge] SIGINT received — stopping');
    monitor.stop();
  });

  monitor.start();
}

main();
