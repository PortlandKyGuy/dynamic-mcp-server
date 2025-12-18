const { parseCliArgs, loadConfig, loadPromptPrefix, substitutePromptVariables, executeTask, startTaskAsync } = require('../src/main');
const fs = require('fs');
const { resolve } = require('path');
const execa = require('execa');

jest.mock('fs');
jest.mock('execa', () => jest.fn().mockResolvedValue({}));

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
    expect(console.error).toHaveBeenCalledWith('Error: a path to a config file must be provided with --config.');
  });

  it('should exit with an error if --prompt is used without a value', () => {
    process.argv.push('--config', 'config.json', '--prompt');
    parseCliArgs();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith('Error: --prompt requires a value (string or file path)');
  });
});
