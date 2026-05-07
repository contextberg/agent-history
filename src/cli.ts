import { startMcpServer } from './mcp/server.js';
import { startWebServer } from './server/index.js';

const isMcp = process.argv.includes('--mcp');
const isDev = process.argv.includes('--dev');

if (isMcp) {
  startMcpServer().catch((err) => {
    console.error('[agent-history] MCP server error:', err);
    process.exit(1);
  });
} else {
  startWebServer({ isDev }).catch((err) => {
    console.error('[agent-history] Failed to start server:', err);
    process.exit(1);
  });
}
