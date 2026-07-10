const assert = require("node:assert/strict");
const test = require("node:test");

const testing = require("../extensionTesting");

test("test item IDs are stable and normalized", () => {
  assert.equal(
    testing.testFileItemId("C:\\repo\\tests\\test_api.py"),
    "ghost-file:c:/repo/tests/test_api.py"
  );
  assert.equal(
    testing.testCaseItemId("C:\\repo\\tests\\test_api.py", "TestAPI::test_ok"),
    "ghost-file:c:/repo/tests/test_api.py:TestAPI::test_ok"
  );
});

test("lookupByTestName prefers qualified names and falls back to simple names", () => {
  const checks = new Map([
    ["test_simple", { status: "grounded" }],
    ["TestAPI::test_method", { status: "borderline" }],
  ]);

  assert.equal(
    testing.lookupByTestName(checks, { name: "test_method", qualifiedName: "TestAPI::test_method" }).status,
    "borderline"
  );
  assert.equal(
    testing.lookupByTestName(checks, { name: "test_simple", qualifiedName: "Other::test_simple" }).status,
    "grounded"
  );
  assert.equal(testing.lookupByTestName(checks, { name: "missing", qualifiedName: "Other::missing" }), undefined);
});

test("groupTestItemsByFile groups runnable items by metadata file path", () => {
  const items = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ];
  const metadata = new Map([
    ["a", { type: "test", filePath: "tests/test_api.py" }],
    ["b", { type: "test", filePath: "tests/test_api.py" }],
    ["c", { type: "test", filePath: "tests/test_other.py" }],
  ]);

  const grouped = testing.groupTestItemsByFile(items, metadata);
  assert.deepEqual(grouped.get("tests/test_api.py"), [items[0], items[1]]);
  assert.deepEqual(grouped.get("tests/test_other.py"), [items[2]]);
});

test("test discovery excludes generated and dependency folders", () => {
  assert.match(testing.TEST_DISCOVERY_EXCLUDE_GLOB, /\*\*\/\.pnpm-store\/\*\*/);
  assert.match(testing.TEST_DISCOVERY_EXCLUDE_GLOB, /\*\*\/node_modules\/\*\*/);
  assert.match(testing.TEST_DISCOVERY_EXCLUDE_GLOB, /\*\*\/\.venv\/\*\*/);
  assert.match(testing.TEST_DISCOVERY_EXCLUDE_GLOB, /\*\*\/docs\/_build\/\*\*/);
});
