import { startMcpServer } from './mcp/server.js';
import { startWebServer } from './server/index.js';

const isMcp = process.argv.includes('--mcp');

if (isMcp) {
  startMcpServer();
} else {
  startWebServer();
}
