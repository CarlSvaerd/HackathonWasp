const assert = require("node:assert/strict");
const test = require("node:test");

const setup = require("../extensionSetup");

test("setupProfileChoices exposes complete local, static, and docker modes", () => {
  const choices = setup.setupProfileChoices();
  assert.deepEqual(choices.map((choice) => choice.id), ["local", "static", "docker"]);
  for (const choice of choices) {
    assert.equal(typeof choice.label, "string");
    assert.equal(typeof choice.description, "string");
    assert.equal(typeof choice.detail, "string");
    assert.notEqual(choice.label.trim(), "");
    assert.notEqual(choice.detail.trim(), "");
  }
});

test("installCommandForPython quotes Python paths and arguments with spaces", () => {
  assert.equal(
    setup.installCommandForPython("C:\\Python 3\\python.exe", ["-m", "pip", "install", "-e", "."]),
    "\"C:\\Python 3\\python.exe\" -m pip install -e ."
  );
  assert.equal(
    setup.installCommandForPython("python", ["-m", "pip", "install", "ghost test catcher"]),
    "python -m pip install \"ghost test catcher\""
  );
});

test("doctorFallbackReport preserves configured source paths and runtime settings", () => {
  const config = {
    get(name, fallback) {
      if (name === "testMode") {
        return "unit";
      }
      if (name === "executeTests") {
        return false;
      }
      return fallback;
    },
  };

  assert.deepEqual(
    setup.doctorFallbackReport(config, ["src", "lib"], "doctor failed"),
    {
      config: {
        source_paths: ["src", "lib"],
        test_paths: [],
        test_mode: "unit",
        execute_tests: false,
      },
      discovered_source_specs: [],
      discovered_test_specs: [],
      error: "doctor failed",
    }
  );
});

test("setup timeout constants are explicit and product-safe", () => {
  assert.equal(setup.DOCTOR_TIMEOUT_MS, 30000);
  assert.equal(setup.SETUP_TIMEOUT_MS, 300000);
});
