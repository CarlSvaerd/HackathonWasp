// @ts-check

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * @typedef {{
 *   baseEnv?: NodeJS.ProcessEnv,
 *   includeWorkspacePaths?: boolean,
 *   extraPythonPaths?: string[],
 *   pathDelimiter?: string
 * }} PythonEnvOptions
 *
 * @typedef {{
 *   isCancellationRequested?: boolean,
 *   onCancellationRequested?: (listener: () => void) => { dispose: () => void }
 * }} CancellationTokenLike
 *
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   label?: string,
 *   timeout?: number,
 *   timeoutMs?: number,
 *   maxBuffer?: number,
 *   logOutput?: (message: string) => void,
 *   appendOutput?: (chunk: string) => void,
 *   token?: CancellationTokenLike
 * }} ExecFileOptions
 *
 * @typedef {{ stdout: string, stderr: string }} ExecFileResult
 * @typedef {Error & { cancelled?: boolean, stdout?: string, stderr?: string, exitCode?: number, code?: string }} ExtensionProcessError
 */

/**
 * Builds the Python environment used by extension-owned CLI calls.
 *
 * @param {string} root
 * @param {PythonEnvOptions} [options]
 * @returns {NodeJS.ProcessEnv}
 */
function buildPythonEnv(root, options = {}) {
  const env = { ...(options.baseEnv || process.env) };
  const includeWorkspacePaths = Boolean(options.includeWorkspacePaths);
  const delimiter = options.pathDelimiter || path.delimiter;
  const entries = [];
  for (const extraPath of options.extraPythonPaths || []) {
    const candidate = String(extraPath || "").trim();
    if (candidate) {
      entries.push(candidate);
    }
  }
  if (includeWorkspacePaths) {
    entries.push(path.join(root, "src"), root);
  }
  if (env.PYTHONPATH) {
    entries.push(env.PYTHONPATH);
  }
  if (entries.length) {
    env.PYTHONPATH = entries.join(delimiter);
  }
  return env;
}

/**
 * Finds the Python source tree that ships with the VS Code extension package.
 * Development hosts fall back to the repository src directory.
 *
 * @param {string} extensionPath
 * @returns {string}
 */
function resolveBundledPythonSourcePath(extensionPath) {
  const candidates = [
    path.join(extensionPath, "python-src"),
    path.resolve(extensionPath, "..", "..", "src"),
  ];
  return candidates.find(isGhostCliSourcePath) || "";
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isGhostCliSourcePath(candidate) {
  return Boolean(candidate)
    && fsExists(path.join(candidate, "ghost_test_catcher", "cli.py"))
    && fsExists(path.join(candidate, "llmSHAP", "ghost", "cli.py"));
}

/**
 * @param {string} directory
 * @returns {boolean}
 */
function shouldSkipDirectory(directory) {
  const normalized = toPosixPath(directory).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const skippedNames = [
    ".git",
    ".hg",
    ".mypy_cache",
    ".pnpm-store",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
  ];
  return segments.some((segment) => skippedNames.includes(segment))
    || normalized.includes("/docs/_build/")
    || normalized.endsWith("/docs/_build");
}

/**
 * Runs a child process without shell interpolation, collects bounded output,
 * and terminates the full process tree on cancellation or timeout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {ExecFileOptions} [options]
 * @returns {Promise<ExecFileResult>}
 */
function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const label = options.label || command;
    const timeoutMs = options.timeout || options.timeoutMs || 0;
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    const logOutput = typeof options.logOutput === "function" ? options.logOutput : () => {};
    const appendOutput = typeof options.appendOutput === "function" ? options.appendOutput : () => {};
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle;
    let cancellation;

    logOutput(`Running ${label}: ${command} ${args.map(quoteForLog).join(" ")}`);

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (cancellation) {
        cancellation.dispose();
      }
    };
    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const stopProcess = (message) => {
      terminateProcess(child);
      const error = /** @type {ExtensionProcessError} */ (new Error(message));
      error.cancelled = message.toLowerCase().includes("cancelled");
      finishReject(error);
    };
    const appendStdout = (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer) {
        stopProcess(`${label} produced more than ${maxBuffer} bytes of stdout.`);
      }
    };
    const appendStderr = (chunk) => {
      stderr += chunk;
      appendOutput(chunk);
      if (Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        stopProcess(`${label} produced more than ${maxBuffer} bytes of stderr.`);
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", appendStdout);
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", appendStderr);
    }

    child.on("error", (error) => {
      const processError = /** @type {ExtensionProcessError} */ (new Error(processStartFailureMessage(label, command, error)));
      processError.code = /** @type {{ code?: string }} */ (error).code;
      finishReject(processError);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }
      const message = stderr.trim() || stdout.trim() || `${label} exited with code ${code}.`;
      const error = /** @type {ExtensionProcessError} */ (new Error(message));
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      finishReject(error);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        stopProcess(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }, timeoutMs);
    }
    if (options.token && typeof options.token.onCancellationRequested === "function") {
      cancellation = options.token.onCancellationRequested(() => {
        stopProcess(`${label} was cancelled.`);
      });
      if (options.token.isCancellationRequested) {
        stopProcess(`${label} was cancelled.`);
      }
    }
  });
}

/**
 * @param {string} label
 * @param {string} command
 * @param {unknown} error
 * @returns {string}
 */
function processStartFailureMessage(label, command, error) {
  const candidate = /** @type {{ code?: string, message?: string }} */ (error || {});
  if (candidate.code === "ENOENT") {
    return `Could not start ${label}. The executable "${command}" was not found. Check the configured path, install the required tool, or run Ghost Test Catcher: Setup.`;
  }
  return `Could not start ${label} with "${command}": ${candidate.message || "unknown process start error"}`;
}

/**
 * @param {import("child_process").ChildProcess} child
 * @returns {void}
 */
function terminateProcess(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const killer = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      child.kill();
    });
    return;
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 3000);
  if (typeof killTimer.unref === "function") {
    killTimer.unref();
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isCancellationError(error) {
  const candidate = /** @type {{ cancelled?: boolean, message?: string }} */ (error || {});
  return Boolean(candidate.cancelled) || /cancelled/i.test(candidate.message || "");
}

/**
 * @param {CancellationTokenLike | undefined} token
 * @param {string} message
 * @returns {void}
 */
function throwIfCancellationRequested(token, message) {
  if (token?.isCancellationRequested) {
    const error = /** @type {ExtensionProcessError} */ (new Error(message));
    error.cancelled = true;
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function quoteForLog(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * @returns {string}
 */
function createNonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

/**
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isInsideOrEqualPath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toPosixPath(value) {
  return String(value).replace(/[\\/]+/g, "/");
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function fsExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  buildPythonEnv,
  createNonce,
  execFile,
  isCancellationError,
  isInsideOrEqualPath,
  processStartFailureMessage,
  resolveBundledPythonSourcePath,
  quoteForLog,
  shouldSkipDirectory,
  throwIfCancellationRequested,
};
