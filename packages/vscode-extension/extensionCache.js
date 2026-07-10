// @ts-check

const fs = require("fs");
const path = require("path");
const core = require("./extensionCore");
const {
  isInsideOrEqualPath,
  shouldSkipDirectory,
} = require("./extensionUtils");

const ANALYSIS_CACHE_STORAGE_KEY = "ghostTestCatcher.analysisCache.v1";
const DEFAULT_ANALYSIS_CACHE_MAX_ENTRIES = 100;

/**
 * @typedef {{ get: (key: string, defaultValue?: any) => any, update: (key: string, value: any) => PromiseLike<void> }} WorkspaceStateLike
 * @typedef {{ get: (key: string, defaultValue?: any) => any }} ConfigLike
 * @typedef {{ workspaceState?: WorkspaceStateLike, getConfig?: () => ConfigLike, logOutput?: (message: string) => void, maxEntries?: number }} AnalysisCacheOptions
 * @typedef {{ path: string, kind?: "file" | "directory", missing?: boolean, mtimeMs?: number, size?: number }} FingerprintEntry
 * @typedef {{ root?: string, testFile?: string, sourcePaths?: string[] }} CacheMetadata
 * @typedef {{ key: string, metadata: CacheMetadata, fingerprints: FingerprintEntry[], result: Record<string, any>, createdAt?: number, updatedAt?: number }} PersistedCacheEntry
 * @typedef {{ count: number, limit: number, exceeded: boolean }} FingerprintState
 */

class AnalysisCacheManager {
  /**
   * @param {AnalysisCacheOptions} [options]
   */
  constructor(options = {}) {
    if (!options.workspaceState) {
      throw new Error("AnalysisCacheManager requires VS Code workspaceState.");
    }
    if (typeof options.getConfig !== "function") {
      throw new Error("AnalysisCacheManager requires getConfig.");
    }
    this.workspaceState = /** @type {WorkspaceStateLike} */ (options.workspaceState);
    this.getConfig = /** @type {() => ConfigLike} */ (options.getConfig);
    this.logOutput = typeof options.logOutput === "function" ? options.logOutput : () => {};
    this.maxEntries = Number(options.maxEntries || DEFAULT_ANALYSIS_CACHE_MAX_ENTRIES);
    /** @type {Map<string, PersistedCacheEntry>} */
    this.entries = new Map();
  }

  load() {
    this.entries.clear();
    if (!this.shouldPersist()) {
      this.workspaceState.update(ANALYSIS_CACHE_STORAGE_KEY, []).then(undefined, (error) => {
        this.logOutput(`Failed to clear persisted analysis cache after persistence was disabled: ${error.message}`);
      });
      return;
    }

    const persistedEntries = this.workspaceState.get(ANALYSIS_CACHE_STORAGE_KEY, []) || [];
    for (const entry of persistedEntries) {
      if (isPersistedCacheEntry(entry)) {
        this.entries.set(entry.key, entry);
      }
    }
  }

  async clear() {
    this.entries.clear();
    await this.persist();
  }

  async persist() {
    if (!this.shouldPersist()) {
      await this.workspaceState.update(ANALYSIS_CACHE_STORAGE_KEY, []);
      return;
    }

    const persistedEntries = Array.from(this.entries.values())
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, this.maxEntries);
    await this.workspaceState.update(ANALYSIS_CACHE_STORAGE_KEY, persistedEntries);
  }

  async restore(limit) {
    if (!this.shouldPersist()) {
      return [];
    }

    const restored = [];
    let pruned = false;
    const fingerprintLimit = Number(limit || this.getConfig().get("cacheFingerprintLimit", 300));
    for (const [key, entry] of this.entries.entries()) {
      const metadata = entry.metadata || {};
      if (!metadata.root || !metadata.testFile || !Array.isArray(metadata.sourcePaths)) {
        this.entries.delete(key);
        pruned = true;
        continue;
      }

      const fingerprints = await this.buildFingerprints(
        metadata.root,
        metadata.testFile,
        metadata.sourcePaths,
        fingerprintLimit
      );
      if (!fingerprints || !fingerprintsEqual(fingerprints, entry.fingerprints)) {
        this.entries.delete(key);
        pruned = true;
        continue;
      }

      const result = cloneJson(entry.result);
      result.__testFile = metadata.testFile;
      result.__sourcePaths = metadata.sourcePaths;
      result.__inferredSourcePaths = result.__inferredSourcePaths || [];
      result.__cacheHit = true;
      restored.push(result);
    }

    if (pruned) {
      await this.persist();
    }
    return restored;
  }

  read(cacheKey, fingerprints) {
    const entry = this.entries.get(cacheKey);
    if (!entry || !fingerprintsEqual(fingerprints, entry.fingerprints)) {
      return null;
    }
    entry.updatedAt = Date.now();
    this.persist().catch((error) => this.logOutput(`Failed to update cache recency: ${error.message}`));
    return cloneJson(entry.result);
  }

  async write(cacheKey, metadata, fingerprints, result) {
    this.entries.set(cacheKey, {
      key: cacheKey,
      metadata: cloneJson(metadata),
      fingerprints,
      result: cloneJson(result),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async buildFingerprints(root, testFile, sourcePaths, limit) {
    const entries = [];
    const state = { count: 0, limit: Number(limit || 300), exceeded: false };
    await this.addFingerprintForPath(entries, testFile, state);
    for (const sourcePath of sourcePaths || []) {
      const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(root, sourcePath);
      await this.addFingerprintForPath(entries, absolute, state);
      if (state.exceeded) {
        this.logOutput(`Skipping analysis cache because source fingerprinting exceeded ${state.limit} files.`);
        return null;
      }
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async addFingerprintForPath(entries, targetPath, state) {
    if (state.exceeded) {
      return;
    }

    let stats;
    try {
      stats = await fs.promises.stat(targetPath);
    } catch {
      entries.push({ path: core.normalizePath(targetPath), missing: true });
      return;
    }

    if (stats.isDirectory()) {
      if (shouldSkipDirectory(targetPath)) {
        return;
      }
      entries.push(fingerprintEntry(targetPath, stats, "directory"));
      const files = [];
      await collectFingerprintFiles(targetPath, files, state);
      for (const file of files) {
        if (state.exceeded) {
          return;
        }
        await this.addFingerprintForPath(entries, file, state);
      }
      return;
    }

    if (stats.isFile()) {
      state.count += 1;
      if (state.count > state.limit) {
        state.exceeded = true;
        return;
      }
      entries.push(fingerprintEntry(targetPath, stats, "file"));
    }
  }

  async invalidateForPath(changedPath) {
    const normalized = core.normalizePath(changedPath);
    let changed = false;
    for (const [key, entry] of this.entries.entries()) {
      const metadata = entry.metadata || {};
      const root = metadata.root || "";
      const testFile = metadata.testFile || "";
      const sourcePaths = metadata.sourcePaths || [];
      const fingerprintHit = (entry.fingerprints || []).some((item) => item.path === normalized);
      const sourceSpecHit = sourcePaths.some((sourcePath) => {
        const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(root, sourcePath);
        return isInsideOrEqualPath(changedPath, absolute);
      });
      if (core.normalizePath(testFile) === normalized || fingerprintHit || sourceSpecHit) {
        this.entries.delete(key);
        changed = true;
      }
    }

    if (changed) {
      await this.persist();
    }
    return changed;
  }

  shouldPersist() {
    return Boolean(this.getConfig().get("persistAnalysisCache", true));
  }
}

/**
 * @param {string} directory
 * @param {string[]} files
 * @param {FingerprintState} state
 * @returns {Promise<void>}
 */
async function collectFingerprintFiles(directory, files, state) {
  if (state.exceeded || shouldSkipDirectory(directory)) {
    return;
  }

  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFingerprintFiles(absolute, files, state);
      continue;
    }
    if (entry.isFile() && core.isPythonPath(absolute)) {
      files.push(absolute);
      if (files.length > state.limit) {
        state.exceeded = true;
        return;
      }
    }
  }
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isPersistedCacheEntry(entry) {
  const candidate = /** @type {Partial<PersistedCacheEntry>} */ (entry || {});
  return Boolean(candidate.key && candidate.result && candidate.fingerprints && candidate.metadata);
}

/**
 * @param {string} file
 * @param {import("fs").Stats} stats
 * @param {"file" | "directory"} kind
 * @returns {FingerprintEntry}
 */
function fingerprintEntry(file, stats, kind) {
  return {
    path: core.normalizePath(file),
    kind,
    mtimeMs: Math.round(Number(stats.mtimeMs || 0)),
    size: Number(stats.size || 0),
  };
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function fingerprintsEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  ANALYSIS_CACHE_STORAGE_KEY,
  AnalysisCacheManager,
  cloneJson,
  fingerprintEntry,
  fingerprintsEqual,
};
