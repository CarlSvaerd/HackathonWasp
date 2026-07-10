const childProcess = require("child_process");
const crypto = require("crypto");
const path = require("path");

function buildPythonEnv(root, options = {}) {
  const env = { ...(options.baseEnv || process.env) };
  const includeWorkspacePaths = Boolean(options.includeWorkspacePaths);
  const delimiter = options.pathDelimiter || path.delimiter;
  const entries = [];
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
      const error = new Error(message);
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
      finishReject(error);
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
      const error = new Error(message);
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
    if (options.token) {
      cancellation = options.token.onCancellationRequested(() => {
        stopProcess(`${label} was cancelled.`);
      });
      if (options.token.isCancellationRequested) {
        stopProcess(`${label} was cancelled.`);
      }
    }
  });
}

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

function isCancellationError(error) {
  return Boolean(error?.cancelled) || /cancelled/i.test(error?.message || "");
}

function throwIfCancellationRequested(token, message) {
  if (token?.isCancellationRequested) {
    const error = new Error(message);
    error.cancelled = true;
    throw error;
  }
}

function quoteForLog(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

function isInsideOrEqualPath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosixPath(value) {
  return String(value).replace(/[\\/]+/g, "/");
}

module.exports = {
  buildPythonEnv,
  createNonce,
  execFile,
  isCancellationError,
  isInsideOrEqualPath,
  quoteForLog,
  shouldSkipDirectory,
  throwIfCancellationRequested,
};
