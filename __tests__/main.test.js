const { parseCliArgs, loadConfig, loadPromptPrefix, substitutePromptVariables, buildTaskPrompt, executeTask, startTaskAsync, resolveJobTimeoutMs, jobs } = require('../src/main');
const fs = require('fs');
const { resolve } = require('path');
const execa = require('execa');

jest.mock('fs');
jest.mock('execa', () => jest.fn().mockResolvedValue({}));

beforeEach(() => {
  jobs.clear();
});

describe('executeTask', () => {
  it('should call execa with the correct command and arguments', async () => {
    await executeTask('gemini', 'gemini-pro', 'test prompt', '/test/dir');
    expect(execa).toHaveBeenCalledWith('gemini', ['--model', 'gemini-pro', '-y', '-p', 'test prompt'], expect.any(Object));
  });
});

describe('startTaskAsync', () => {
  it('should call execa with the correct command and arguments', () => {
    startTaskAsync('gemini', 'gemini-pro', 'test prompt', '/test/dir', 'test-tool');
    expect(execa).toHaveBeenCalledWith('gemini', ['--model', 'gemini-pro', '-y', '-p', 'test prompt'], expect.any(Object));
  });

  it('should return a jobId and store a running job', () => {
    const jobId = startTaskAsync('gemini', 'gemini-pro', 'test prompt', '/test/dir', 'test-tool');
    const job = jobs.get(jobId);
    expect(jobId).toMatch(/^job_/);
    expect(job.status).toBe('running');
    expect(job.toolName).toBe('test-tool');
  });

  it('should mark the job as failed on timeout and attempt to kill the process', () => {
    jest.useFakeTimers();
    process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS = '10';

    const pending = new Promise(() => {});
    pending.kill = jest.fn();
    execa.mockReturnValueOnce(pending);

    const jobId = startTaskAsync('gemini', 'gemini-pro', 'test prompt', '/test/dir', 'test-tool');

    jest.advanceTimersByTime(11);

    const job = jobs.get(jobId);
    expect(job.status).toBe('failed');
    expect(job.result.stderr).toContain('Timed out after 10ms');
    expect(pending.kill).toHaveBeenCalledWith('SIGTERM');

    delete process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS;
    jest.useRealTimers();
  });
});

describe('substitutePromptVariables', () => {
  it('should correctly substitute variables in a prompt template', () => {
    const template = 'Hello, {{name}}! You are {{age}} years old.';
    const params = { name: 'John', age: 30 };
    const result = substitutePromptVariables(template, params);
    expect(result).toBe('Hello, John! You are 30 years old.');
  });

  it('should handle missing variables gracefully', () => {
    const template = 'Hello, {{name}}! You are {{age}} years old.';
    const params = { name: 'John' };
    const result = substitutePromptVariables(template, params);
    expect(result).toBe('Hello, John! You are  years old.');
  });
});

describe('buildTaskPrompt', () => {
  it('should substitute variables when a template is provided', () => {
    const tool = { inputs: [{ name: 'name', type: 'string' }] };
    const result = buildTaskPrompt(tool, 'Hello {{name}}', { name: 'Ada' }, null);
    expect(result).toBe('Hello Ada');
  });

  it('should fall back to the first string input when no template is provided', () => {
    const tool = {
      inputs: [
        { name: 'count', type: 'number' },
        { name: 'query', type: 'string' }
      ]
    };
    const result = buildTaskPrompt(tool, null, { count: 2, query: 'Find results' }, null);
    expect(result).toBe('Find results');
  });

  it('should fall back to JSON when no string input is present', () => {
    const tool = { inputs: [{ name: 'count', type: 'number' }] };
    const result = buildTaskPrompt(tool, null, { count: 2 }, null);
    expect(result).toBe(JSON.stringify({ count: 2 }));
  });

  it('should prepend the prompt prefix when provided', () => {
    const tool = { inputs: [{ name: 'query', type: 'string' }] };
    const result = buildTaskPrompt(tool, null, { query: 'Ship it' }, 'Prefix');
    expect(result).toBe('Prefix\nShip it');
  });
});

describe('loadPromptPrefix', () => {
  it('should return null if no prompt argument is provided', () => {
    const result = loadPromptPrefix(null);
    expect(result).toBeNull();
  });

  it('should return the string if the prompt argument is not a file path', () => {
    fs.existsSync.mockReturnValue(false);
    const result = loadPromptPrefix('My prompt');
    expect(result).toBe('My prompt');
  });

  it('should return the file content if the prompt argument is a valid file path', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('File content');
    const result = loadPromptPrefix('prompt.txt');
    expect(result).toBe('File content');
  });
});

describe('resolveJobTimeoutMs', () => {
  it('should return the default when env var is missing', () => {
    delete process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS;
    const timeoutMs = resolveJobTimeoutMs();
    expect(timeoutMs).toBeGreaterThan(0);
  });

  it('should return the env value when valid', () => {
    process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS = '1234';
    const timeoutMs = resolveJobTimeoutMs();
    expect(timeoutMs).toBe(1234);
    delete process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS;
  });
});

describe('loadConfig', () => {
  const originalExit = process.exit;
  const originalError = console.error;

  beforeEach(() => {
    process.exit = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    process.exit = originalExit;
    console.error = originalError;
    jest.clearAllMocks();
  });

  it('should correctly load and parse a valid JSON config file', () => {
    const config = { model: 'gemini', tools: [{ name: 'test', description: 'a test', inputs: [] }] };
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    const result = loadConfig('config.json');
    expect(result).toEqual(config);
  });

  it('should exit with an error if the config file does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    loadConfig('config.json');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Configuration file not found'));
  });

  it('should exit with an error for an invalid JSON config file', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('invalid json');
    loadConfig('config.json');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error processing configuration file'));
  });
});

describe('parseCliArgs', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalError = console.error;

  beforeEach(() => {
    process.argv = ['node', 'test'];
    process.exit = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.error = originalError;
  });

  it('should correctly parse the config file path', () => {
    process.argv.push('--config', 'config.json');
    const { configPath } = parseCliArgs();
    expect(configPath).toBe('config.json');
  });

  it('should correctly parse the --prompt argument', () => {
    process.argv.push('--config', 'config.json', '--prompt', 'My prompt');
    const { promptArg } = parseCliArgs();
    expect(promptArg).toBe('My prompt');
  });

  it('should correctly parse the -p argument', () => {
    process.argv.push('--config', 'config.json', '-p', 'My prompt');
    const { promptArg } = parseCliArgs();
    expect(promptArg).toBe('My prompt');
  });

  it('should correctly parse the --async flag', () => {
    process.argv.push('--config', 'config.json', '--async');
    const { asyncArg } = parseCliArgs();
    expect(asyncArg).toBe(true);
  });

  it('should exit with an error if no config file path is provided', () => {
    parseCliArgs();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: dynamic-mcp-server --config'));
    expect(console.error).toHaveBeenCalledWith('Error: a path to a config file must be provided with --config.');
  });

  it('should exit with an error if --prompt is used without a value', () => {
    process.argv.push('--config', 'config.json', '--prompt');
    parseCliArgs();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith('Error: --prompt requires a value (string or file path)');
  });
});
