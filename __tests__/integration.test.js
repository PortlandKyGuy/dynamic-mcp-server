const { spawn } = require('child_process');
const path = require('path');

const mainScript = path.resolve(__dirname, '../src/main.js');
const configFile = path.resolve(__dirname, 'test-config.json');
const { version: packageVersion } = require('../package.json');

describe('Integration Tests', () => {
  it('should start the server and output the correct MCP handshake', (done) => {
    const process = spawn('node', [mainScript, '--config', configFile, '--handshake-and-exit']);
    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', () => {
      const output = JSON.parse(stdout);
      expect(output).toEqual({
        mcp_version: '1.0',
        server_name: 'Test Server',
        server_version: packageVersion,
        tools: [
          {
            toolName: 'test',
            command: 'echo',
            args: ['hello'],
          },
        ],
      });
      done();
    });
  });
});
