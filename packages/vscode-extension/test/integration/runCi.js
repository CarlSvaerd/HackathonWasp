const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..", "..");
const logPath = path.join(extensionRoot, "vscode-integration.log");
const command = buildCommand();

fs.writeFileSync(
  logPath,
  [
    "Ghost Test Catcher VS Code integration CI",
    `runner=${process.env.RUNNER_OS || process.platform}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `cwd=${extensionRoot}`,
    `command=${[command.bin, ...command.args].join(" ")}`,
    "",
  ].join(os.EOL),
  "utf8"
);

console.log(`Ghost Test Catcher integration CI command: ${[command.bin, ...command.args].join(" ")}`);
console.log(`Ghost Test Catcher integration CI log: ${logPath}`);

let finished = false;
let child;

try {
  child = childProcess.spawn(command.bin, command.args, {
    cwd: extensionRoot,
    env: process.env,
    shell: false,
    windowsHide: true,
  });
} catch (error) {
  finish(1, `Could not start integration command: ${error.message}`);
}

if (child) {
  child.stdout.on("data", (chunk) => appendOutput(chunk, process.stdout));
  child.stderr.on("data", (chunk) => appendOutput(chunk, process.stderr));
  child.on("error", (error) => finish(1, `Could not start integration command: ${error.message}`));
  child.on("close", (code, signal) => {
    if (code === 0) {
      finish(0, "Integration command completed successfully.");
      return;
    }
    const status = typeof code === "number" ? code : 1;
    const reason = signal
      ? `Integration command exited with signal ${signal}.`
      : `Integration command exited with code ${status}.`;
    finish(status, reason);
  });
}

function buildCommand() {
  const packageManager = packageManagerName();
  if (process.platform === "linux") {
    return {
      bin: "xvfb-run",
      args: ["-a", packageManager, "run", "test:integration"],
    };
  }

  if (process.platform === "win32") {
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", `${packageManager} run test:integration`],
    };
  }

  return {
    bin: packageManager,
    args: ["run", "test:integration"],
  };
}

function packageManagerName() {
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.startsWith("pnpm/")) {
    return "pnpm";
  }
  if (userAgent.startsWith("yarn/")) {
    return "yarn";
  }
  return "npm";
}

function appendOutput(chunk, stream) {
  fs.appendFileSync(logPath, chunk);
  stream.write(chunk);
}

function finish(status, reason) {
  if (finished) {
    return;
  }
  finished = true;

  if (status === 0) {
    console.log("Ghost Test Catcher integration CI completed successfully.");
    return;
  }

  fs.appendFileSync(logPath, `${os.EOL}${reason}${os.EOL}`, "utf8");
  const logText = fs.readFileSync(logPath, "utf8");
  const tail = tailLines(logText, 120);
  writeStepSummary(reason, tail);
  writeErrorAnnotation(reason, tail);
  console.error(reason);
  process.exit(status);
}

function writeStepSummary(reason, tail) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const body = [
    "## VS Code Integration Failed",
    "",
    `Runner: ${process.env.RUNNER_OS || process.platform} (${process.platform}/${process.arch})`,
    `Command: \`${[command.bin, ...command.args].join(" ")}\``,
    `Reason: ${reason}`,
    "",
    "```text",
    tail,
    "```",
    "",
  ].join(os.EOL);

  fs.appendFileSync(summaryPath, body, "utf8");
}

function writeErrorAnnotation(reason, tail) {
  const message = [
    `Runner: ${process.env.RUNNER_OS || process.platform} (${process.platform}/${process.arch})`,
    `Command: ${[command.bin, ...command.args].join(" ")}`,
    `Reason: ${reason}`,
    "",
    tail,
  ].join("\n");
  const trimmed = message.length > 3500 ? message.slice(message.length - 3500) : message;
  console.log(`::error title=${escapeProperty("VS Code integration failed")}::${escapeData(trimmed)}`);
}

function tailLines(value, limit) {
  const normalized = String(value || "").replace(/\r\n/g, "\n");
  return normalized.split("\n").slice(-limit).join("\n").trimEnd();
}

function escapeData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeProperty(value) {
  return escapeData(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}
