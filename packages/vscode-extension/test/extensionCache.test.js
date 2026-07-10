const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cache = require("../extensionCache");
const core = require("../extensionCore");

function createWorkspaceState(initial = {}) {
  const state = { ...initial };
  return {
    state,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback;
    },
    async update(key, value) {
      state[key] = value;
    },
  };
}

function createManager(options = {}) {
  return new cache.AnalysisCacheManager({
    workspaceState: options.workspaceState || createWorkspaceState(),
    getConfig: () => ({
      get(name, fallback) {
        if (name === "persistAnalysisCache") {
          return options.persist !== undefined ? options.persist : true;
        }
        if (name === "cacheFingerprintLimit") {
          return options.cacheFingerprintLimit || fallback;
        }
        return fallback;
      },
    }),
    logOutput: options.logOutput || (() => {}),
    maxEntries: options.maxEntries || 100,
  });
}

test("AnalysisCacheManager writes, reads, clones, and persists entries", async () => {
  const workspaceState = createWorkspaceState();
  const manager = createManager({ workspaceState });
  const fingerprints = [{ path: "c:/repo/tests/test_api.py", kind: "file", mtimeMs: 1, size: 2 }];
  const metadata = {
    root: "C:/repo",
    testFile: "C:/repo/tests/test_api.py",
    sourcePaths: ["src"],
  };
  const result = { generated_tests: { test_names: ["test_api"] } };

  await manager.write("cache-key", metadata, fingerprints, result);
  const cached = manager.read("cache-key", fingerprints);
  cached.generated_tests.test_names.push("mutated");
  const cachedAgain = manager.read("cache-key", fingerprints);

  assert.deepEqual(cachedAgain.generated_tests.test_names, ["test_api"]);
  assert.equal(workspaceState.state[cache.ANALYSIS_CACHE_STORAGE_KEY].length, 1);
});

test("AnalysisCacheManager clears persisted state when persistence is disabled", async () => {
  const workspaceState = createWorkspaceState({
    [cache.ANALYSIS_CACHE_STORAGE_KEY]: [{ key: "old" }],
  });
  const manager = createManager({ workspaceState, persist: false });

  manager.load();
  await manager.clear();

  assert.deepEqual(workspaceState.state[cache.ANALYSIS_CACHE_STORAGE_KEY], []);
});

test("AnalysisCacheManager builds fingerprints and skips generated folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-cache-"));
  const tests = path.join(root, "tests");
  const src = path.join(root, "src");
  const store = path.join(root, ".pnpm-store", "v11");
  fs.mkdirSync(tests, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(tests, "test_api.py"), "def test_api():\n    assert True\n", "utf-8");
  fs.writeFileSync(path.join(src, "api.py"), "def ok():\n    return True\n", "utf-8");
  fs.writeFileSync(path.join(store, "generated.py"), "SHOULD_NOT_APPEAR = True\n", "utf-8");

  const manager = createManager();
  const fingerprints = await manager.buildFingerprints(root, path.join(tests, "test_api.py"), ["src", ".pnpm-store"], 20);
  const paths = fingerprints.map((item) => item.path);

  assert.ok(paths.includes(core.normalizePath(path.join(src, "api.py"))));
  assert.equal(paths.some((item) => item.includes(".pnpm-store")), false);
  assert.equal(paths.some((item) => item.includes("generated.py")), false);
});

test("AnalysisCacheManager invalidates cache entries by fingerprint and source path", async () => {
  const manager = createManager();
  const root = "C:/repo";
  const metadata = {
    root,
    testFile: "C:/repo/tests/test_api.py",
    sourcePaths: ["src"],
  };
  const fingerprints = [{ path: "c:/repo/src/api.py", kind: "file", mtimeMs: 1, size: 2 }];
  await manager.write("cache-key", metadata, fingerprints, { ok: true });

  assert.equal(await manager.invalidateForPath("C:/repo/src/api.py"), true);
  assert.equal(manager.read("cache-key", fingerprints), null);
});

test("fingerprintsEqual compares stable serialized fingerprints", () => {
  const left = [{ path: "a.py", size: 1 }];
  const right = [{ path: "a.py", size: 1 }];
  const changed = [{ path: "a.py", size: 2 }];

  assert.equal(cache.fingerprintsEqual(left, right), true);
  assert.equal(cache.fingerprintsEqual(left, changed), false);
});
