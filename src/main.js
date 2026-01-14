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
const { createWriteStream } = require("node:fs");
const { version: packageVersion } = require("../package.json");

const LOG_LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];
const LOG_LEVELS = LOG_LEVEL_ORDER.reduce((acc, level, index) => {
  acc[level] = index;
  return acc;
}, {});
const LOG_CATEGORY_VALUES = ["requests", "responses", "steps"];
const DEFAULT_LOGGING = {
  enabled: true,
  level: "info",
  format: "json",
  destination: "stderr",
  categories: LOG_CATEGORY_VALUES,
  logPayloads: false,
  payloadMaxChars: null,
};

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
    async: z.boolean().optional(),
    logging: z.lazy(() => ConfigSchemas.Logging).optional(),
    inputs: z.array(z.lazy(() => ConfigSchemas.ConfigInput)).optional().default([]),
  }),
  Logging: z.object({
    enabled: z.boolean().optional(),
    level: z.enum([...LOG_LEVEL_ORDER, "off"]).optional(),
    format: z.enum(["json", "pretty"]).optional(),
    destination: z.string().optional(),
    categories: z.union([
      z.literal("all"),
      z.array(z.enum(LOG_CATEGORY_VALUES)),
    ]).optional(),
    logPayloads: z.boolean().optional(),
    payloadMaxChars: z.number().int().positive().optional(),
  }).optional(),
  Config: z.object({
    name: z.string().optional(),
    model: z.enum(["claude", "codex", "gemini"]),
    modelId: z.string().optional(),
    logging: z.lazy(() => ConfigSchemas.Logging).optional(),
    tools: z.array(z.lazy(() => ConfigSchemas.ConfigTool)).min(1),
  }),
};

/**
 * A in-memory store for tracking asynchronous jobs.
 */
const jobs = new Map();
let jobIdCounter = 0;
const DEFAULT_JOB_TIMEOUT_MS = 20 * 60 * 1000;

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
  const loggingArgs = {};
  let logDisabled = false;

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
    } else if (arg === "--log-level") {
      loggingArgs.level = process.argv[++i];
      if (!loggingArgs.level) {
        console.error("Error: --log-level requires a value");
        process.exit(1);
      }
    } else if (arg === "--log-format") {
      loggingArgs.format = process.argv[++i];
      if (!loggingArgs.format) {
        console.error("Error: --log-format requires a value");
        process.exit(1);
      }
    } else if (arg === "--log-destination") {
      loggingArgs.destination = process.argv[++i];
      if (!loggingArgs.destination) {
        console.error("Error: --log-destination requires a value");
        process.exit(1);
      }
    } else if (arg === "--log-categories") {
      loggingArgs.categories = process.argv[++i];
      if (!loggingArgs.categories) {
        console.error("Error: --log-categories requires a value");
        process.exit(1);
      }
    } else if (arg === "--log-payloads") {
      loggingArgs.logPayloads = true;
    } else if (arg === "--log-payload-max-chars") {
      loggingArgs.payloadMaxChars = Number.parseInt(process.argv[++i], 10);
      if (!Number.isFinite(loggingArgs.payloadMaxChars) || loggingArgs.payloadMaxChars <= 0) {
        console.error("Error: --log-payload-max-chars requires a positive integer value");
        process.exit(1);
      }
    } else if (arg === "--no-logging") {
      logDisabled = true;
    }
  }

  if (!configPath) {
    console.error("Usage: dynamic-mcp-server --config <path> [--prompt <string|file>] [--async] [--handshake-and-exit]");
    console.error("Error: a path to a config file must be provided with --config.");
    process.exit(1);
  }

  return { configPath, promptArg, asyncArg, handshakeAndExitArg, loggingArgs, logDisabled };
}

function resolveJobTimeoutMs() {
  const parsed = Number.parseInt(process.env.DYNAMIC_MCP_JOB_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_JOB_TIMEOUT_MS;
}

function parseBooleanEnv(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeLogLevel(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") return "off";
  if (LOG_LEVELS[normalized] !== undefined) return normalized;
  return undefined;
}

function normalizeLogFormat(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "json" || normalized === "pretty") return normalized;
  return undefined;
}

function normalizeLogCategories(value) {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const normalized = raw
    .map(item => String(item).trim().toLowerCase())
    .filter(Boolean);
  if (normalized.includes("all")) {
    return [...LOG_CATEGORY_VALUES];
  }
  const categories = normalized.filter(item => LOG_CATEGORY_VALUES.includes(item));
  return categories.length > 0 ? categories : undefined;
}

function normalizeLoggingOverrides(input) {
  if (!input || typeof input !== "object") return {};
  const overrides = {};
  if (typeof input.enabled === "boolean") overrides.enabled = input.enabled;
  if (typeof input.logPayloads === "boolean") overrides.logPayloads = input.logPayloads;
  const level = normalizeLogLevel(input.level);
  if (level) overrides.level = level;
  const format = normalizeLogFormat(input.format);
  if (format) overrides.format = format;
  if (typeof input.destination === "string" && input.destination.trim()) {
    overrides.destination = input.destination.trim();
  }
  const categories = normalizeLogCategories(input.categories);
  if (categories) overrides.categories = categories;
  if (Number.isFinite(input.payloadMaxChars) && input.payloadMaxChars > 0) {
    overrides.payloadMaxChars = input.payloadMaxChars;
  }
  return overrides;
}

function resolveLoggingConfig(configLogging, cliLogging, logDisabled, env = process.env) {
  const envOverrides = {
    enabled: parseBooleanEnv(env.DYNAMIC_MCP_LOG_ENABLED),
    level: env.DYNAMIC_MCP_LOG_LEVEL,
    format: env.DYNAMIC_MCP_LOG_FORMAT,
    destination: env.DYNAMIC_MCP_LOG_DESTINATION,
    categories: env.DYNAMIC_MCP_LOG_CATEGORIES,
    logPayloads: parseBooleanEnv(env.DYNAMIC_MCP_LOG_PAYLOADS_ENABLED),
    payloadMaxChars: Number.parseInt(env.DYNAMIC_MCP_LOG_PAYLOAD_MAX_CHARS ?? "", 10),
  };

  let resolved = { ...DEFAULT_LOGGING };
  resolved = { ...resolved, ...normalizeLoggingOverrides(configLogging) };
  resolved = { ...resolved, ...normalizeLoggingOverrides(envOverrides) };
  resolved = { ...resolved, ...normalizeLoggingOverrides(cliLogging) };

  const disabledByCli = Boolean(logDisabled);
  if (disabledByCli || resolved.level === "off") {
    resolved.enabled = false;
  }

  if (!Array.isArray(resolved.categories) || resolved.categories.length === 0) {
    resolved.categories = [];
  }

  return { ...resolved, disabledByCli };
}

function resolveToolLoggingConfig(baseConfig, toolLogging) {
  if (!baseConfig) return baseConfig;
  if (baseConfig.disabledByCli) {
    return { ...baseConfig, enabled: false };
  }
  const overrides = normalizeLoggingOverrides(toolLogging);
  const merged = { ...baseConfig, ...overrides };
  if (typeof overrides.enabled === "boolean") {
    merged.enabled = overrides.enabled;
  } else {
    merged.enabled = baseConfig.enabled;
  }
  if (overrides.level === "off") {
    merged.enabled = false;
  }
  if (!Array.isArray(merged.categories) || merged.categories.length === 0) {
    merged.categories = [];
  }
  return merged;
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function truncateString(value, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function maybeTruncatePayload(payload, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return payload;
  return truncateString(safeStringify(payload), maxChars);
}

function createLogger(loggingConfig, streamRegistry) {
  const config = { ...DEFAULT_LOGGING, ...loggingConfig };
  const levelValue = LOG_LEVELS[config.level] ?? LOG_LEVELS.info;
  const categorySet = new Set(config.categories || []);

  let stream = null;
  if (config.destination === "stdout") {
    stream = process.stdout;
  } else if (config.destination === "stderr") {
    stream = process.stderr;
  } else if (typeof config.destination === "string" && config.destination.trim()) {
    const destination = config.destination;
    if (streamRegistry && streamRegistry.has(destination)) {
      stream = streamRegistry.get(destination);
    } else {
      try {
        stream = createWriteStream(destination, { flags: "a" });
        if (streamRegistry) {
          streamRegistry.set(destination, stream);
        }
      } catch (error) {
        stream = process.stderr;
      }
    }
  } else {
    stream = process.stderr;
  }

  const shouldLogPayloads = () => config.logPayloads || levelValue >= LOG_LEVELS.debug;

  const shouldLog = (level, category) => {
    if (!config.enabled) return false;
    const levelRank = LOG_LEVELS[level];
    if (levelRank === undefined || levelRank > levelValue) return false;
    if (categorySet.size === 0) return false;
    if (!categorySet.has(category)) return false;
    return true;
  };

  const writeLine = (line) => {
    if (!line || !stream || typeof stream.write !== "function") return;
    try {
      stream.write(`${line}\n`);
    } catch (error) {
      // swallow logging errors
    }
  };

  const formatLine = (level, category, message, meta, payload) => {
    const timestamp = new Date().toISOString();
    if (config.format === "pretty") {
      let line = `[${timestamp}] ${level.toUpperCase()} ${category} ${message}`;
      if (meta && Object.keys(meta).length > 0) {
        line += ` ${safeStringify(meta)}`;
      }
      if (payload !== undefined) {
        line += ` payload=${safeStringify(payload)}`;
      }
      return line;
    }
    const entry = {
      timestamp,
      level,
      category,
      message,
      ...meta,
    };
    if (payload !== undefined) {
      entry.payload = payload;
    }
    return safeStringify(entry);
  };

  const log = (level, category, message, meta = {}, payload) => {
    if (!shouldLog(level, category)) return;
    const line = formatLine(level, category, message, meta, payload);
    writeLine(line);
  };

  return {
    config,
    shouldLogPayloads,
    log,
    error: (category, message, meta, payload) => log("error", category, message, meta, payload),
    warn: (category, message, meta, payload) => log("warn", category, message, meta, payload),
    info: (category, message, meta, payload) => log("info", category, message, meta, payload),
    debug: (category, message, meta, payload) => log("debug", category, message, meta, payload),
    trace: (category, message, meta, payload) => log("trace", category, message, meta, payload),
  };
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
 * Builds the task prompt, ensuring tool parameters are included even when no template is provided.
 * @param {object} tool - The tool definition.
 * @param {string|null} toolPromptTemplate - The loaded tool prompt template.
 * @param {object} toolParams - Parameters provided to the tool.
 * @param {string|null} promptPrefix - Optional prefix from CLI.
 * @returns {string} The final task prompt.
 */
function buildTaskPrompt(tool, toolPromptTemplate, toolParams, promptPrefix) {
  let task;
  if (toolPromptTemplate) {
    task = substitutePromptVariables(toolPromptTemplate, toolParams);
  } else {
    const firstStringInput = (tool.inputs || []).find(input => input.type === "string");
    task = firstStringInput ? String(toolParams[firstStringInput.name] ?? "") : JSON.stringify(toolParams);
  }
  return promptPrefix ? `${promptPrefix}\n${task}` : task;
}

function countChars(value) {
  return safeStringify(value).length;
}

function buildRequestMeta(toolName, toolAsync, toolParams, task, promptPrefix) {
  return {
    toolName,
    async: toolAsync,
    paramsChars: countChars(toolParams),
    taskChars: task.length,
    hasPromptPrefix: Boolean(promptPrefix),
  };
}

function buildResponseMeta(toolName, toolAsync, result, durationMs, jobId) {
  const meta = {
    toolName,
    async: toolAsync,
    durationMs,
  };

  if (jobId) {
    meta.jobId = jobId;
    return meta;
  }

  if (result) {
    meta.exitCode = result.exitCode;
    meta.stdoutChars = countChars(result.stdout ?? "");
    meta.stderrChars = countChars(result.stderr ?? "");
  }

  return meta;
}

/**
 * Resolves whether a tool should run asynchronously.
 * Tool-level async setting overrides the server default.
 * @param {object} tool - The tool definition.
 * @param {boolean} serverAsync - Default async flag for the server.
 * @returns {boolean}
 */
function resolveToolAsyncFlag(tool, serverAsync) {
  if (typeof tool.async === "boolean") {
    return tool.async;
  }
  return serverAsync;
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
function startTaskAsync(model, modelId, task, cwd, toolName, logger) {
  const jobId = generateJobId();
  const timeoutMs = resolveJobTimeoutMs();
  jobs.set(jobId, {
    status: "running",
    toolName,
    startedAt: new Date().toISOString(),
    result: null,
    timeoutMs,
  });

  if (logger) {
    logger.info("steps", "job_started", {
      jobId,
      toolName,
      timeoutMs,
    });
  }

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

  let timeoutId = null;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      const job = jobs.get(jobId);
      if (!job || job.status !== "running") {
        return;
      }

      jobs.set(jobId, {
        ...job,
        status: "failed",
        completedAt: new Date().toISOString(),
        result: {
          exitCode: -1,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
        },
        timedOut: true,
      });

      if (logger) {
        logger.warn("steps", "job_timed_out", {
          jobId,
          toolName,
          timeoutMs,
        });
      }

      if (typeof subprocess.kill === "function") {
        subprocess.kill("SIGTERM");
        setTimeout(() => {
          try {
            subprocess.kill("SIGKILL");
          } catch (error) {
            // best-effort cleanup
          }
        }, 5000);
      }
    }, timeoutMs);
  }

  const finalizeJob = (status, result) => {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") {
      return;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    jobs.set(jobId, {
      ...job,
      status,
      completedAt: new Date().toISOString(),
      result,
    });

    if (logger) {
      const level = status === "completed" ? "info" : "warn";
      logger[level]("steps", "job_finished", {
        jobId,
        toolName,
        status,
        exitCode: result?.exitCode,
      });
    }
  };

  subprocess.then(({ exitCode, stdout, stderr }) => {
    finalizeJob((exitCode ?? -1) === 0 ? "completed" : "failed", {
      exitCode: exitCode ?? -1,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    });
  }).catch((error) => {
    finalizeJob("failed", { exitCode: -1, stdout: "", stderr: error.message });
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

function registerConfiguredTools(server, config, promptPrefix, serverAsync, loggingConfig, streamRegistry) {
  let hasAsyncTools = false;

  config.tools.forEach(tool => {
    const toolLoggingConfig = resolveToolLoggingConfig(loggingConfig, tool.logging);
    const toolLogger = createLogger(toolLoggingConfig, streamRegistry);
    const inputSchema = buildInputSchema(tool.inputs);
    const toolPromptTemplate = loadToolPrompt(tool);
    const toolAsync = resolveToolAsyncFlag(tool, serverAsync);

    if (toolLogger) {
      toolLogger.info("steps", "tool_registered", {
        toolName: tool.name,
        async: toolAsync,
      });
    }

    if (toolAsync) {
      hasAsyncTools = true;
      server.registerTool(tool.name, {
        description: `${tool.description}\n\nThis tool runs asynchronously and returns a job ID. Use 'check-job-status' to poll for completion.`,
        inputSchema,
        outputSchema: { jobId: z.string(), status: z.string(), message: z.string() }
      }, (params) => {
        const { cwd, ...toolParams } = params;
        const fullTask = buildTaskPrompt(tool, toolPromptTemplate, toolParams, promptPrefix);
        if (toolLogger) {
          const requestMeta = buildRequestMeta(tool.name, toolAsync, toolParams, fullTask, promptPrefix);
          const payload = toolLogger.shouldLogPayloads()
            ? maybeTruncatePayload({ params: toolParams, task: fullTask }, toolLogger.config.payloadMaxChars)
            : undefined;
          toolLogger.info("requests", "tool_request", requestMeta, payload);
        }

        const jobId = startTaskAsync(config.model, config.modelId, fullTask, cwd, tool.name, toolLogger);
        if (toolLogger) {
          const responseMeta = buildResponseMeta(tool.name, toolAsync, null, 0, jobId);
          toolLogger.info("responses", "tool_response", responseMeta);
        }

        const structuredContent = {
          jobId,
          status: "running",
          message: `Job started. Use 'check-job-status' with jobId '${jobId}' to check progress.`,
        };
        return {
          content: [{ type: "text", text: `Job started: ${jobId}\nStatus: running\n\nUse 'check-job-status' tool with this jobId to poll for completion.` }],
          structuredContent,
          isError: false,
        };
      });
    } else {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema,
        outputSchema: { exitCode: z.number(), stdout: z.string(), stderr: z.string() }
      }, async (params) => {
        const { cwd, ...toolParams } = params;
        const fullTask = buildTaskPrompt(tool, toolPromptTemplate, toolParams, promptPrefix);
        const startTime = Date.now();
        if (toolLogger) {
          const requestMeta = buildRequestMeta(tool.name, toolAsync, toolParams, fullTask, promptPrefix);
          const payload = toolLogger.shouldLogPayloads()
            ? maybeTruncatePayload({ params: toolParams, task: fullTask }, toolLogger.config.payloadMaxChars)
            : undefined;
          toolLogger.info("requests", "tool_request", requestMeta, payload);
        }
        const result = await executeTask(config.model, config.modelId, fullTask, cwd);
        if (toolLogger) {
          const durationMs = Date.now() - startTime;
          const responseMeta = buildResponseMeta(tool.name, toolAsync, result, durationMs);
          const payload = toolLogger.shouldLogPayloads()
            ? maybeTruncatePayload({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" }, toolLogger.config.payloadMaxChars)
            : undefined;
          toolLogger.info("responses", "tool_response", responseMeta, payload);
        }
        return {
          content: [{ type: "text", text: `stdout: ${result.stdout}\nstderr: ${result.stderr}` }],
          structuredContent: result,
          isError: result.exitCode !== 0,
        };
      });
    }
  });

  return hasAsyncTools;
}

/**
 * The main function to set up and start the MCP server.
 */
async function main() {
  const { configPath, promptArg, asyncArg, handshakeAndExitArg, loggingArgs, logDisabled } = parseCliArgs();
  const validatedConfig = loadConfig(configPath);
  const promptPrefix = loadPromptPrefix(promptArg);
  const loggingConfig = resolveLoggingConfig(validatedConfig.logging, loggingArgs, logDisabled);
  const streamRegistry = new Map();
  const logger = createLogger(loggingConfig, streamRegistry);

  const serverName = validatedConfig.name || basename(configPath, ".json") + "-mcp-server";

  const server = new McpServer({
    name: serverName,
    version: packageVersion ?? "0.0.0",
  });

  if (logger) {
    logger.info("steps", "server_start", {
      serverName,
      version: packageVersion ?? "0.0.0",
      asyncDefault: asyncArg,
    });
  }

  const hasAsyncTools = registerConfiguredTools(server, validatedConfig, promptPrefix, asyncArg, loggingConfig, streamRegistry);

  if (hasAsyncTools) {
    server.registerTool("check-job-status", {
      description: "Check the status of an async job. Poll this tool until status is 'completed' or 'failed'. Returns the job result when complete.",
      inputSchema: { jobId: z.string().describe("The job ID returned from the async tool call") },
      outputSchema: {
        jobId: z.string(),
        status: z.enum(["running", "completed", "failed"]),
        toolName: z.string().optional(),
        startedAt: z.string().optional(),
        completedAt: z.string().optional(),
        result: z.object({
          exitCode: z.number(),
          stdout: z.string(),
          stderr: z.string(),
        }).nullish(),
      }
    }, async ({ jobId }) => {
      if (logger) {
        const requestMeta = {
          toolName: "check-job-status",
          async: false,
          paramsChars: countChars({ jobId }),
          taskChars: 0,
          hasPromptPrefix: false,
        };
        const payload = logger.shouldLogPayloads()
          ? maybeTruncatePayload({ jobId }, logger.config.payloadMaxChars)
          : undefined;
        logger.info("requests", "tool_request", requestMeta, payload);
      }

      const job = jobs.get(jobId);

      if (!job) {
        const structuredContent = {
          jobId,
          status: "failed",
          error: `Job not found: ${jobId}`,
        };
        return {
          content: [{ type: "text", text: `Error: Job not found: ${jobId}` }],
          structuredContent,
          isError: true,
        };
      }

      const structuredContent = {
        jobId,
        status: job.status,
        toolName: job.toolName,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        result: job.result,
      };

      let textContent;
      if (job.status === "running") {
        textContent = `Job ${jobId} is still running (started: ${job.startedAt}).\nPoll again to check for completion.`;
      } else {
        textContent = `Job ${jobId} ${job.status} (completed: ${job.completedAt})\n\nstdout: ${job.result?.stdout ?? ""}\nstderr: ${job.result?.stderr ?? ""}`;
      }

      if (logger) {
        const responseMeta = {
          toolName: "check-job-status",
          async: false,
          status: job.status,
          jobId,
          exitCode: job.result?.exitCode,
          stdoutChars: countChars(job.result?.stdout ?? ""),
          stderrChars: countChars(job.result?.stderr ?? ""),
        };
        const payload = logger.shouldLogPayloads()
          ? maybeTruncatePayload({
            status: job.status,
            result: job.result ? {
              exitCode: job.result.exitCode,
              stdout: job.result.stdout ?? "",
              stderr: job.result.stderr ?? "",
            } : null
          }, logger.config.payloadMaxChars)
          : undefined;
        logger.info("responses", "tool_response", responseMeta, payload);
      }

      return {
        content: [{ type: "text", text: textContent }],
        structuredContent,
        isError: job.status === "failed",
      };
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (handshakeAndExitArg) {
    const handshake = createHandshakeSummary(validatedConfig, serverName);
    // Print handshake to stdout so tests/clients can parse it.
    console.log(JSON.stringify(handshake));
    console.error('Exiting after handshake');
    if (logger) {
      logger.info("steps", "handshake_exit", { serverName });
    }
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
    buildTaskPrompt,
    resolveLoggingConfig,
    resolveToolLoggingConfig,
    normalizeLogCategories,
    resolveToolAsyncFlag,
    executeTask,
    startTaskAsync,
    createHandshakeSummary,
    registerConfiguredTools,
    resolveJobTimeoutMs,
    createLogger,
    jobs
  };
}
