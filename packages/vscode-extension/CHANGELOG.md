# Changelog

## 0.1.0

- Added `Ghost Test Catcher: Analyze Current Test File`.
- Added `Ghost Test Catcher: Analyze Changed Test Files`.
- Added `Ghost Test Catcher: Analyze Selected Files or Folders` for Explorer and editor selections.
- Added `Ghost Test Catcher: Run Doctor` for project root, Python path, importability, and config diagnostics.
- Added smart source context that resolves local imports from the selected test file before configured source folders.
- Added inline diagnostics on pytest-style functions and `unittest.TestCase` methods.
- Added CodeLens verdict summaries above analyzed tests.
- Added an HTML report panel with reliability, Effective Test Value, framework, run status, risk categories, recommendations, missing symbols, and evidence symbols.
- Added configuration for Python path, source paths, smart source context, execution confirmation, test mode, and max files.
- Added nested Python project root detection for workspaces opened above the actual package root.
- Added local packaging with `npm run package`.
