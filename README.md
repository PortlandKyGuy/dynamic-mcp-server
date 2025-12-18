# Dynamic MCP Server

A versatile server for the Model Context Protocol (MCP) that dynamically configures tools from a JSON file.

## How it Works

The `dynamic-mcp-server` is a single, executable that can power multiple, distinct MCP servers. The behavior of each server is defined by a JSON configuration file that is loaded at startup. This means you can create many different MCP servers with different tools and prompts, all from the same running instance.

The following diagram illustrates this architecture:

```
+------------------------+      +----------------------+      +-----------------+
|  Configuration File 1  |----->|                      |----->|   Model's CLI   |
| (e.g., code-review.json)|      |                      |      | (claude, gemini)|
+------------------------+      | dynamic-mcp-server   |      +-----------------+
                                | (this project)       |
+------------------------+      |                      |      +-----------------+
|  Configuration File 2  |----->|                      |----->|   Model's CLI   |
| (e.g., docs-qa.json)   |      |                      |      | (claude, gemini)|
+------------------------+      +----------------------+      +-----------------+
```

**⚠️ WARNING: Dangerous Run Modes ⚠️**

By default, this server is configured to use certain "dangerous" flags when interacting with `claude`, `codex`, and `gemini` CLIs (e.g., `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `-y`). These flags are intended for development and testing purposes and should be used with extreme caution in production environments, as they can bypass important security and safety mechanisms. Review `src/main.js` to understand these flags and modify them if your use case requires stricter security.

## Use Cases

The `dynamic-mcp-server` can be used to create a variety of powerful tools that integrate with AI models. Here are a few examples:

*   **Code Review Agent:** Create a tool that reviews your code for style, errors, and best practices. You can configure it to use a specific model and prompt to match your team's coding standards.
*   **Documentation Assistant:** Build a tool that can answer questions about your codebase, generate documentation, or provide examples of how to use a specific function.
*   **Custom Workflows:** Implement complex workflows that involve multiple AI models. For example, you could create a workflow that first uses a code generation model to write a function, and then uses a code review model to check the generated code.
*   **CLI Front-end:** The `dynamic-mcp-server` allows you to create a CLI front-end for models like Gemini, Claude, and Codex. This is useful for users who prefer to interact with these models from the command line, but still want to leverage the power of MCP.
*   **Model-Specific Prompts:**  Instead of relying on a generic prompt, the `dynamic-mcp-server` allows you to create model-specific prompts that are tailored to the strengths of each model. This can lead to better results and a more efficient workflow.

---

## CLI Versions

This project is based on, and tested with, the following CLI versions:

* Claude Code: 1.0.128
* Codex CLI: 0.73.0
* Gemini CLI: 0.21.0

---

## Creating a Dynamic MCP Server

To create a new `dynamic-mcp-server`, you need to define a JSON configuration file. This file specifies the model to use, the tools to expose, and the prompts for each tool.

### Configuration File Structure

The server is configured using a JSON file. This file can be located anywhere on your file system.

```json
{
  "name": "architect-reviewer",
  "model": "gemini",
  "modelId": "gemini-2.5-flash",
  "tools": [
    {
      "name": "ci-cd-review",
      "description": "A description of what my tool does.",
      "prompt": "A prompt template using {{variable}} syntax.",
      "inputs": [
        {
          "name": "variable",
          "type": "string",
          "description": "Description of the input.",
          "required": true
        }
      ]
    }
  ]
}
```

#### Config Options

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Server name (defaults to config filename) |
| `model` | Yes | CLI to use: `"claude"`, `"codex"`, or `"gemini"` |
| `modelId` | No | Specific model ID to pass to the CLI (e.g., `"claude-sonnet-4-20250514"`) |
| `tools` | Yes | Array of tool definitions |

### Tool Definition

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool name (no spaces or dots) |
| `description` | Yes | What the tool does |
| `prompt` | No | Prompt template with `{{variable}}` placeholders |
| `promptFile` | No | Path to a file containing the prompt template (takes precedence over `prompt`) |
| `inputs` | No | Array of input parameters |
| `command` / `args` | No | Optional; currently not executed by the server. The model prompt drives the CLI call. Extend `src/main.js` if you want per-tool shell commands. |

### Input Definition

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Parameter name |
| `type` | Yes | Type: `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"` |
| `description` | Yes | Parameter description |
| `required` | No | Whether required (defaults to `true`) |

See the `examples/` folder for sample configurations.

---

## Using a Dynamic MCP Server

Once you have created a configuration file for your `dynamic-mcp-server`, you need to configure your model's CLI to use it.

### Installation

First, install the `dynamic-mcp-server` globally:

```bash
npm install -g .
```

This makes the `dynamic-mcp-server` command available on your PATH. In your MCP client configs (Claude, Codex, Gemini), set the server command to `dynamic-mcp-server` and pass your JSON config path as the first argument (plus any flags like `--async` or `--prompt`).

### MCP Client Configuration

MCP Clients are your Codex, Claude, Gemini CLIs. These settings tell your CLI what is available and how to use the dynamic-mcp-servers you created.

#### CLI Options

| Option | Description |
|--------|-------------|
| `<config-file-path>` | Path to the JSON configuration file (required) |
| `--prompt`, `-p` | A prompt string or path to a prompt file. If provided, this prompt is prepended to every task with a newline separator. If the value is a valid file path, its contents are used. |

### Prompt Prefix

The `--prompt` option allows you to prepend a system prompt to every task. This is useful for:
- Setting consistent behavior across all tools
- Adding project-specific context or guidelines
- Defining output format requirements

**Note**: Prompt can be used at the MCP Server configuration level, thus applying to all tools in that server, or at the Tool Definition level, giving the tool a specific prompt. 

**Using a prompt file:**
```bash
dynamic-mcp-server config.json --prompt /path/to/system-prompt.txt
```

**Using a literal string:**
```bash
dynamic-mcp-server config.json --prompt "Always respond in JSON format"
```

**Example prompt file** (`examples/code-review-prompt.txt`):

Here is a very simple prompt. Not recommended to use, as it hasn't been vetted. Here for example only.

```
You are an expert code reviewer with deep knowledge of software engineering best practices.

When reviewing code, always consider:
- Security vulnerabilities (OWASP Top 10)
- Performance implications
- Maintainability and readability
- Error handling and edge cases
- Adherence to SOLID principles

Be constructive and specific in your feedback. Reference line numbers when applicable.
```

When used with the `code-review.json` config, every code review task will have this prompt prepended to it.

---

## Validation & Smoke Tests

Two layers of checks help catch protocol or CLI regressions early:

* **Quick handshake smoke:** `dynamic-mcp-server --config /path/to/config.json --handshake-and-exit`  
  - Exits after printing handshake JSON to stdout; useful to confirm wiring before running clients.

* **Protocol-only (no external CLIs):** `npm run verify:protocol`  
  - Spawns `src/main.js --handshake-and-exit` with `__tests__/test-config.json` and validates the handshake JSON.  
  - Fails if output contains “error” or is not JSON.

* **CLI-specific smoke (per model):** `npm run verify:clients`  
  - Verifies each CLI (`claude`, `codex`, `gemini`) is installed and at least the versions listed in “CLI Versions”.  
  - Performs a handshake-only smoke test per model; captures stdout/stderr to temp files and deletes them automatically.  
  - Missing/unauthenticated CLIs are skipped with a clear message.

* **Full CLI exercise:** `npm run verify:clients:full` (sets `EXERCISE_CLI=1`)  
  - Additionally runs a simple tool call via each CLI using `executeTask`.  
  - Asserts expected text, checks that neither stdout nor stderr contains “error”, and cleans temp files via traps.  
  - Gemini’s exercise step is skipped by default because its CLI can auto-invoke tools and emit quota errors; set `SKIP_GEMINI_EXERCISE=0` to force it.
  - Note: the maintainer rarely uses the Gemini CLI, so Gemini support may lag behind Claude/Codex; run the forced exercise if you rely on Gemini and open issues if it breaks.
* **Known limitations:**  
  - Gemini CLI can auto-invoke tools and return quota errors; its exercise test is off by default.  
  - Default CLI flags are “dangerous” and should be tightened for production.  
  - Async jobs are in-memory only; they don’t survive process restarts.

### Prerequisites
* Node.js environment.
* Model CLIs installed and authenticated: `claude`, `codex`, `gemini`.
* CLI flags assumed by this project:  
  * Claude: `--dangerously-skip-permissions`  
  * Codex: `--dangerously-bypass-approvals-and-sandbox --search exec --skip-git-repo-check`  
  * Gemini: `-y -p`
* If newer CLI versions change these flags, the CLI smoke tests will fail fast and print the detected version so you can update `src/main.js` / `CLI_CONFIG`.

### Artifacts & Cleanup
* Temp files created via `mktemp`; removed on `EXIT` traps.  
* On failure, the script prints temp file paths so you can inspect them; on success, `/tmp` is left clean.  
* Set `DEBUG_KEEP=1` to retain temp files for debugging.

---

### Async Mode

Some MCP clients have tool execution timeouts. For long-running tasks, you can enable async mode using the `--async` flag when starting the server.

**Starting with async mode:**
```bash
dynamic-mcp-server config.json --async
```

When `--async` is used, the server will start the long-running task in the background and poll for its completion internally. This makes the asynchronous nature of the task transparent to the client. The client makes a single request and gets a single response, even though the server is doing a lot of work in the background.

#### Claude

In your model's configuration file (e.g., `~/.claude/config.json`), you can add multiple entries for the `dynamic-mcp-server`, each with its own configuration file.

For the dynamic MCP server with a custom config:
```json
{
  "mcpServers": {
    "architecture-reviewer": {
      "command": "dynamic-mcp-server",
      "args": ["/path/to/dynamic-mcp-server-config-for-architecture-reviewer.json", "--async"],
      "timeout": 120
    }
  }
}
```

With a prompt prefix (string or file path):
```json
{
  "mcpServers": {
    "tech-manager": {
      "command":"dynamic-mcp-server",
      "args": ["/path/to/dynamic-mcp-server-config-for-tech-manager.json", "--prompt", "/path/to/system-prompt.txt", "--async"],
      "timeout": 120
    }
  }
}
```

The `timeout` field (in seconds) controls startup timeout. For Claude cli the default is 60 seconds. Tool execution has a hardcoded 10-minute limit.

Now, when you run your model's CLI, it will automatically start the `dynamic-mcp-server` for each entry and make the tools you defined in your configuration files available.

#### Codex

Set up codex `config.toml` like:

For the dynamic MCP server:
```toml
[mcp_servers.architect-reviewer]
command = "dynamic-mcp-server"
args = ["/path/to/dynamic-mcp-server-config-for-architecture-reviewer"]
startup_timeout_sec = 60
tool_timeout_sec = 2400
```

With a prompt prefix:
```toml
[mcp_servers.tech-manager]
command = "dynamic-mcp-server"
args = ["/path/to/dynamic-mcp-server-config-for-tech-manager.json", "--prompt", "/path/to/system-prompt.txt"]
startup_timeout_sec = 60
tool_timeout_sec = 2400
```

Make sure the `tool_timeout_sec` is long so that the dynamic-mcp-server can finish finish its work.

#### Gemini

For Gemini, you'll configure MCP servers in the `gemini` CLI's configuration file.

For the dynamic MCP server:
```json
{
  "mcp-servers": {
    "architect-reviewer": {
      "command": "dynamic-mcp-server",
      "args": ["/path/to/dynamic-mcp-server-config-for-architecture-reviewer.json", "--async"]
    }
  }
}
```

With a prompt prefix (string or file path):
```json
{
  "mcp-servers": {
    "tech-manager": {
      "command":"dynamic-mcp-server",
      "args": ["/path/to/dynamic-mcp-server-config-for-tech-manager.json", "--prompt", "/path/to/system-prompt.txt", "--async"]
    }
  }
}
```

Now, when you run `gemini`, it will automatically start the `dynamic-mcp-server` for each entry and make the tools you defined in your configuration files available.

This software is provided "as is" and the user assumes all risks and responsibilities associated with its use. The owner of the repository is not responsible for any issues, problems, loss, damage, or other liabilities that may arise from the use of this software.

## AI Use

AI was used for some coding, testing, and documentation. Human had the original idea, original code, and performed all code reviews. 

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
