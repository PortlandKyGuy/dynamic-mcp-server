#!/usr/bin/env node

/**
 * @file This script implements a Dynamic MCP (Model Context Protocol) Server.
 * It loads tool definitions from a JSON configuration file, allowing for the
 * creation of multiple MCP server instances from a single codebase.
 * The server can interact with different AI models via their command-line interfaces.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const execa = require("execa");
const { readFileSync, existsSync } = require("node:fs");
const { resolve, basename } = require("node:path");
const { version: packageVersion } = require("../package.json");

/**
 * Configuration for supported AI model CLIs.
 * Defines the command and base arguments for each model.
 */
const CLI_CONFIG = {
  claude: {
    command: "claude",
    baseArgs: ["--dangerously-skip-permissions", "-p"],
  },
  codex: {
    command: "codex",
    baseArgs: ["--dangerously-bypass-approvals-and-sandbox", "--search", "exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
  },
  gemini: {
    command: "gemini",
    baseArgs: ["-y", "-p"],
  }
};

/**
 * Zod schemas for validating the JSON configuration file.
 */
const ConfigSchemas = {
  ConfigInput: z.object({
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "array", "object"]),
    description: z.string(),
    required: z.boolean().optional().default(true),
  }),
  ConfigTool: z.object({
    name: z.string(),
    description: z.string(),
    command: z.string().optional(),
    args: z.array(z.any()).optional(),
    prompt: z.string().optional(),
    promptFile: z.string().optional(),
    inputs: z.array(z.lazy(() => ConfigSchemas.ConfigInput)).optional().default([]),
  }),
  Config: z.object({
    name: z.string().optional(),
    model: z.enum(["claude", "codex", "gemini"]),
    modelId: z.string().optional(),
    tools: z.array(z.lazy(() => ConfigSchemas.ConfigTool)).min(1),
  }),
};

/**
 * A in-memory store for tracking asynchronous jobs.
 */
const jobs = new Map();
let jobIdCounter = 0;

/**
 * Generates a unique ID for a new job.
 * @returns {string} A unique job ID.
 */
function generateJobId() {
  return `job_${Date.now()}_${++jobIdCounter}`;
}

function parseCliArgs() {
  let configPath = null;
  let promptArg = null;
  let asyncArg = false;
  let handshakeAndExitArg = false;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--config") {
      configPath = process.argv[++i];
      if (!configPath) {
        console.error("Error: --config requires a value (file path)");
        process.exit(1);
      }
    } else if (arg === "--prompt" || arg === "-p") {
      promptArg = process.argv[++i];
      if (!promptArg) {
        console.error("Error: --prompt requires a value (string or file path)");
        process.exit(1);
      }
    } else if (arg === "--async") {
      asyncArg = true;
    } else if (arg === "--handshake-and-exit") {
      handshakeAndExitArg = true;
    }
  }

  if (!configPath) {
    console.error("Error: a path to a config file must be provided with --config.");
    process.exit(1);
  }

  return { configPath, promptArg, asyncArg, handshakeAndExitArg };
}


/**
 * Converts a JSON type string to a Zod schema object.
 * @param {string} type - The JSON type.
 * @param {string} description - The description for the schema.
 * @param {boolean} required - Whether the field is required.
 * @returns {z.ZodTypeAny} A Zod schema.
 */
function typeToZod(type, description, required) {
  let schema;
  switch (type) {
    case "string": schema = z.string(); break;
    case "number": schema = z.number(); break;
    case "boolean": schema = z.boolean(); break;
    case "array": schema = z.array(z.any()); break;
    case "object": schema = z.record(z.any()); break;
    default: schema = z.string();
  }
  if (description) schema = schema.describe(description);
  if (!required) schema = schema.optional();
  return schema;
}

/**
 * Builds a Zod input schema from a tool's input definitions.
 * @param {Array} inputs - The array of input definitions from the config.
 * @returns {Object} A Zod schema object.
 */
function buildInputSchema(inputs) {
  const schema = {};
  for (const input of inputs) {
    schema[input.name] = typeToZod(input.type, input.description, input.required);
  }
  return schema;
}

/**
 * Loads the prompt for a tool, preferring a prompt file over an inline prompt.
 * @param {z.infer<typeof ConfigSchemas.ConfigTool>} tool - The tool definition.
 * @returns {string|null} The prompt template.
 */
function loadToolPrompt(tool) {
  if (tool.promptFile) {
    const resolvedPath = resolve(tool.promptFile);
    if (existsSync(resolvedPath)) {
      try {
        return readFileSync(resolvedPath, "utf-8");
      } catch (error) {
        console.error(`Error reading promptFile for tool '${tool.name}': ${error.message}`);
        process.exit(1);
      }
    }
  }
  return tool.prompt || null;
}

/**
 * Substitutes variables in a prompt template.
 * @param {string} template - The prompt template with {{variable}} placeholders.
 * @param {Object} params - The parameters to substitute.
 * @returns {string} The prompt with substituted variables.
 */
function substitutePromptVariables(template, params) {
  const safeTemplate = template || "";
  return safeTemplate.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] ?? "") : "";
  });
}

/**
 * Executes a task by spawning a CLI process.
 * @param {string} model - The model to use ('claude' or 'codex').
 * @param {string|undefined} modelId - The specific model ID.
 * @param {string} task - The task/prompt to execute.
 * @param {string|undefined} cwd - The working directory.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function executeTask(model, modelId, task, cwd) {
  const cliConfig = CLI_CONFIG[model];
  const args = [...cliConfig.baseArgs, task];
  if (modelId) args.unshift("--model", modelId);

  try {
    const { exitCode, stdout, stderr } = await execa(cliConfig.command, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      reject: false,
      all: false,
      stdin: "ignore",
    });
    return { exitCode: exitCode ?? -1, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: error.message };
  }
}

/**
 * Starts a task asynchronously.
 * @param {string} model - The model to use.
 * @param {string|undefined} modelId - The specific model ID.
 * @param {string} task - The task/prompt to execute.
 * @param {string|undefined} cwd - The working directory.
 * @param {string} toolName - The name of the tool being executed.
 * @returns {string} The job ID.
 */
function startTaskAsync(model, modelId, task, cwd, toolName) {
  const jobId = generateJobId();
  jobs.set(jobId, { status: "running", toolName, startedAt: new Date().toISOString(), result: null });

  const cliConfig = CLI_CONFIG[model];
  const args = [...cliConfig.baseArgs, task];
  if (modelId) args.unshift("--model", modelId);

  const subprocess = execa(cliConfig.command, args, {
    cwd: cwd || process.cwd(),
    env: process.env,
    reject: false,
    all: false,
    stdin: "ignore",
  });

  subprocess.then(({ exitCode, stdout, stderr }) => {
    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: (exitCode ?? -1) === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      result: { exitCode: exitCode ?? -1, stdout: stdout ?? "", stderr: stderr ?? "" },
    });
  }).catch((error) => {
    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: "failed",
      completedAt: new Date().toISOString(),
      result: { exitCode: -1, stdout: "", stderr: error.message },
    });
  });

  return jobId;
}

/**
 * The main function to set up and start the MCP server.
 */
function loadConfig(configPath) {
  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    console.error(`Error: Configuration file not found: ${resolvedConfigPath}`);
    process.exit(1);
  }

  try {
    const configContent = readFileSync(resolvedConfigPath, "utf-8");
    const config = JSON.parse(configContent);
    return ConfigSchemas.Config.parse(config);
  } catch (error) {
    console.error(`Error processing configuration file: ${error.message}`);
    process.exit(1);
  }
}

function loadPromptPrefix(promptArg) {
  if (!promptArg) return null;

  const resolvedPromptPath = resolve(promptArg);
  if (existsSync(resolvedPromptPath)) {
    try {
      return readFileSync(resolvedPromptPath, "utf-8");
    } catch (error) {
      console.error(`Error reading prompt file: ${error.message}`);
      process.exit(1);
    }
  }
  return promptArg;
}

/**
 * Build the handshake payload for --handshake-and-exit mode.
 * Kept minimal to satisfy integration tests and external consumers.
 */
function createHandshakeSummary(config, serverName) {
  return {
    mcp_version: "1.0",
    server_name: serverName,
    server_version: packageVersion ?? "0.0.0",
    tools: config.tools.map(tool => ({
      toolName: tool.name,
      command: tool.command || null,
      args: tool.args || null,
    })),
  };
}

/**
 * The main function to set up and start the MCP server.
 */
async function main() {
  const { configPath, promptArg, asyncArg, handshakeAndExitArg } = parseCliArgs();
  const validatedConfig = loadConfig(configPath);
  const promptPrefix = loadPromptPrefix(promptArg);

  const serverName = validatedConfig.name || basename(configPath, ".json") + "-mcp-server";

  const server = new McpServer({
    name: serverName,
    version: packageVersion ?? "0.0.0",
  });

  const pollForJobCompletion = (jobId, resolve) => {
    const job = jobs.get(jobId);
    if (job.status === "completed" || job.status === "failed") {
      resolve({
        content: [{ type: "text", text: `stdout: ${job.result.stdout}\nstderr: ${job.result.stderr}` }],
        structuredContent: job.result,
        isError: job.status === "failed",
      });
    } else {
      setTimeout(() => pollForJobCompletion(jobId, resolve), 1000);
    }
  };

  validatedConfig.tools.forEach(tool => {
    const inputSchema = buildInputSchema(tool.inputs);
    const toolPromptTemplate = loadToolPrompt(tool);

    if (asyncArg) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema,
        outputSchema: { exitCode: z.number(), stdout: z.string(), stderr: z.string() }
      }, (params) => {
        return new Promise((resolve) => {
          const { cwd, ...toolParams } = params;
          const task = substitutePromptVariables(toolPromptTemplate, toolParams);
          const fullTask = promptPrefix ? `${promptPrefix}\n${task}` : task;
          const jobId = startTaskAsync(validatedConfig.model, validatedConfig.modelId, fullTask, cwd, tool.name);
          pollForJobCompletion(jobId, resolve);
        });
      });
    } else {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema,
        outputSchema: { exitCode: z.number(), stdout: z.string(), stderr: z.string() }
      }, async (params) => {
        const { cwd, ...toolParams } = params;
        const task = substitutePromptVariables(toolPromptTemplate, toolParams);
        const fullTask = promptPrefix ? `${promptPrefix}\n${task}` : task;
        const result = await executeTask(validatedConfig.model, validatedConfig.modelId, fullTask, cwd);
        return {
          content: [{ type: "text", text: `stdout: ${result.stdout}\nstderr: ${result.stderr}` }],
          structuredContent: result,
          isError: result.exitCode !== 0,
        };
      });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (handshakeAndExitArg) {
    const handshake = createHandshakeSummary(validatedConfig, serverName);
    // Print handshake to stdout so tests/clients can parse it.
    console.log(JSON.stringify(handshake));
    console.error('Exiting after handshake');
    setTimeout(() => process.exit(0), 50);
  }
}

if (require.main === module) {

  main().catch(error => {

    console.error(`Unhandled error: ${error.message}`);

    process.exit(1);

  });

}



if (process.env.NODE_ENV === 'test') {

  module.exports = {

    parseCliArgs,

    loadConfig,

    loadPromptPrefix,

    substitutePromptVariables,

    executeTask,

    startTaskAsync,

    createHandshakeSummary

  };

}
