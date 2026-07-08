Ghost Test Catcher
==================

Ghost Test Catcher is a trust checker for AI-generated Python tests. It checks
whether tests are grounded in source files, whether they execute in an isolated
Python test workspace, and which files provide the strongest evidence for the
result.

Product Surfaces
----------------

The same Python engine powers three surfaces:

* the FastAPI browser demo
* the ``ghost-test-catcher`` CLI
* the VS Code extension in ``packages/vscode-extension``

CLI
---

Analyze an existing Python test file:

.. code-block:: bash

   ghost-test-catcher analyze \
     --repo . \
     --tests tests/test_auth.py \
     --source src \
     --format pretty

JSON output is intended for editor integrations and CI:

.. code-block:: bash

   ghost-test-catcher analyze \
     --repo . \
     --tests tests/test_auth.py \
     --source src \
     --format json

Calibration
-----------

Run the built-in calibration cases before release or CI gating changes:

.. code-block:: bash

   ghost-test-catcher calibrate --format pretty

The calibration suite includes grounded, missing-symbol, and invented-workflow
cases so regressions are visible without calling an LLM.

CI Gate
-------

Use the CI command when Ghost Test Catcher should act as a pull-request or
release gate:

.. code-block:: bash

   ghost-test-catcher ci \
     --repo . \
     --tests tests/test_auth.py \
     --source src \
     --no-execution \
     --summary ghost-test-catcher-summary.md \
     --output ghost-test-catcher-report.json \
     --format json \
     --fail-on ghost_risk

``--fail-on ghost_risk`` fails only high-risk results. ``--fail-on
needs_review`` fails any result that is not fully reliable. ``--fail-on
never`` keeps the command informational while still writing reports.

VS Code
-------

The extension provides:

* ``Ghost Test Catcher: Analyze Current Test File``
* ``Ghost Test Catcher: Analyze Changed Test Files``
* ``Ghost Test Catcher: Analyze Selected Files or Folders``
* ``Ghost Test Catcher: Run Doctor``
* inline diagnostics on pytest-style functions and ``unittest.TestCase`` methods
* CodeLens verdicts
* a report panel with reliability, ETV, framework, execution status, risk categories, recommendations, evidence, and missing symbols
* smart source context that resolves local imports from the active test before broader configured source folders
* nested Python project root detection when VS Code is opened at a parent folder
* a Doctor report for Python path, module importability, CLI config, discovered source paths, and discovered test paths

Package the local extension:

.. code-block:: bash

   cd packages/vscode-extension
   npm install --ignore-scripts
   npm run check
   npm test
   npm run package

Release Notes
-------------

The extension package contains:

* ``package.json`` Marketplace metadata
* ``media/icon.png`` as a non-SVG extension icon
* ``CHANGELOG.md`` for release history
* ``.vscodeignore`` rules that exclude development-only files

The VS Code publishing tool packages local extensions into VSIX files and can
publish them to Marketplace. The official VS Code documentation warns that
Marketplace publishing does not accept SVG extension icons, so the project
ships a generated PNG icon instead.

Configuration
-------------

Configuration can live in ``pyproject.toml``:

.. code-block:: toml

   [tool.ghost-test-catcher]
   source_paths = ["src"]
   test_paths = ["tests"]
   test_mode = "mixed"
   model = "gpt-4o-mini"
   max_files = 80
   max_chars_per_file = 24000
   max_total_chars = 240000
   execute_tests = true

Safety
------

When execution is enabled, Ghost Test Catcher copies selected tests and source
files into a temporary directory and runs the pytest runner there with plugin
autoloading disabled. Pytest is used as the execution engine because it can
collect both pytest-style functions and ``unittest.TestCase`` methods. This
avoids modifying the workspace during analysis, but it still executes Python
code. Keep confirmation enabled for untrusted generated tests.
