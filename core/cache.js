/**
 * @fileoverview Git History LLM Semantic Cache Manager
 * @module core/cache
 * 
 * This module implements a highly optimized, semantic deduplication and caching layer
 * designed specifically for Git commit histories and diffs. It prevents redundant LLM
 * processing by identifying identical or semantically similar commits using exact
 * hashing and n-gram based similarity scoring.
 * 
 * Features:
 * - Exact match caching (SHA-256 on normalized diffs and messages)
 * - Semantic deduplication (Trigram Jaccard similarity for minor variations)
 * - Length-based heuristic filtering for fast similarity searches
 * - LRU (Least Recently Used) eviction policy to bound memory/disk usage
 * - Atomic disk writes to prevent cache corruption
 * - Detailed cache hit/miss/semantic-match telemetry
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================================================
// Custom Error Definitions
// ============================================================================

/**
 * Custom error class for Cache-related exceptions.
 * @extends Error
 */
class CacheError extends Error {
    /**
     * @param {string} message - Error description
     * @param {string} [code] - Specific error code (e.g., 'CACHE_CORRUPTED')
     */
    constructor(message, code = 'CACHE_ERROR') {
        super(message);
        this.name = 'CacheError';
        this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
}

// ============================================================================
// Utility Functions & Algorithms
// ============================================================================

/**
 * Creates a SHA-256 hash of the given string.
 * @param {string} data - The input string to hash.
 * @returns {string} The hex-encoded SHA-256 hash.
 */
function generateHash(data) {
    if (!data || typeof data !== 'string') return null;
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Normalizes a git diff or commit message for consistent hashing and comparison.
 * Strips out timestamps, normalizes whitespace, and lowercases text.
 * @param {string} text - The raw text (diff or message).
 * @returns {string} The normalized text.
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        // Remove standard git diff index lines which change based on repo state, not content
        .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, '')
        // Remove hunk headers which contain line numbers that shift easily
        .replace(/^@@ -\d+,\d+ \+\d+,\d+ @@.*$/gm, '')
        // Normalize all whitespace sequences to a single space
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generates trigrams (3-character sequences) from a string.
 * Used for fast, language-agnostic semantic similarity comparisons.
 * @param {string} str - The input string.
 * @returns {Set<string>} A set of trigrams.
 */
function extractTrigrams(str) {
    const trigrams = new Set();
    // Pad string slightly to capture boundary trigrams
    const padded = `  ${str}  `;
    for (let i = 0; i < padded.length - 2; i++) {
        trigrams.add(padded.slice(i, i + 3));
    }
    return trigrams;
}

/**
 * Calculates the Jaccard similarity index between two strings using trigrams.
 * @param {string} str1 - First string to compare.
 * @param {string} str2 - Second string to compare.
 * @returns {number} A similarity score between 0.0 (completely different) and 1.0 (identical).
 */
function calculateSemanticSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;
    if (!str1 || !str2) return 0.0;

    const tri1 = extractTrigrams(str1);
    const tri2 = extractTrigrams(str2);

    let intersectionSize = 0;
    // Iterate over the smaller set for performance
    const [smaller, larger] = tri1.size < tri2.size ? [tri1, tri2] : [tri2, tri1];

    for (const trigram of smaller) {
        if (larger.has(trigram)) {
            intersectionSize++;
        }
    }

    const unionSize = tri1.size + tri2.size - intersectionSize;
    return unionSize === 0 ? 1.0 : intersectionSize / unionSize;
}

// ============================================================================
// Cache Manager Implementation
// ============================================================================

/**
 * Default configuration options for the SemanticCache.
 */
const DEFAULT_OPTIONS = {
    // Path to store the cache JSON file
    cacheDir: path.join(os.homedir(), '.githistoryllm', 'cache'),
    cacheFileName: 'semantic_commit_cache.json',
    
    // Semantic similarity threshold (0.0 to 1.0)
    // 0.95 means 95% similar. High threshold prevents false positives.
    similarityThreshold: 0.92,
    
    // Enable/disable semantic matching (exact match always runs)
    enableSemanticMatch: true,
    
    // Maximum number of items to keep in cache before LRU eviction kicks in
    maxEntries: 10000,
    
    // Maximum diff length difference to even attempt a semantic comparison 
    // (e.g., 0.2 means +/- 20% length difference allowed)
    lengthFilterTolerance: 0.2,
    
    // Time-to-live for cache entries in milliseconds (default: 30 days)
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    
    // Whether to automatically persist to disk after setting a new item
    autoSave: true
};

/**
 * SemanticCache
 * 
 * Manages the storage, retrieval, and semantic deduplication of LLM analyses
 * for git commits. Persists data to disk and maintains an LRU memory index.
 */
class SemanticCache {
    /**
     * @param {Object} options - Configuration overrides.
     */
    constructor(options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.cacheFilePath = path.join(this.options.cacheDir, this.options.cacheFileName);
        
        // In-memory data structures
        // Map maintains insertion order, which is useful for LRU eviction
        this.entries = new Map();
        
        // Telemetry
        this.stats = {
            hitsExact: 0,
            hitsSemantic: 0,
            misses: 0,
            evictions: 0,
            errors: 0,
            totalComparisons: 0
        };

        this.isInitialized = false;
        this.isDirty = false;
        this._saveLock = false;
    }

    /**
     * Initializes the cache by ensuring directories exist and loading data from disk.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            // Ensure directory exists
            await fs.mkdir(this.options.cacheDir, { recursive: true });

            // Try to load existing cache
            try {
                const data = await fs.readFile(this.cacheFilePath, 'utf8');
                const parsed = JSON.parse(data);
                
                const now = Date.now();
                let loadedCount = 0;
                let expiredCount = 0;

                // Load entries, filtering out expired ones
                for (const [key, value] of Object.entries(parsed.entries || {})) {
                    if (now - value.timestamp > this.options.ttlMs) {
                        expiredCount++;
                        continue;
                    }
                    this.entries.set(key, value);
                    loadedCount++;
                }

                if (expiredCount > 0) {
                    this.isDirty = true;
                    await this._persist();
                }

            } catch (err) {
                if (err.code !== 'ENOENT') {
                    this.stats.errors++;
                    console.warn(`[GitHistoryLLM Cache] Failed to read cache file, starting fresh. Error: ${err.message}`);
                }
                // If ENOENT, file doesn't exist yet, which is fine.
            }

            this.isInitialized = true;
        } catch (err) {
            this.stats.errors++;
            throw new CacheError(`Initialization failed: ${err.message}`, 'INIT_FAILED');
        }
    }

    /**
     * Generates a structural fingerprint for a commit to be used as a cache key.
     * @param {Object} commit - The commit object.
     * @param {string} commit.diff - The git diff string.
     * @param {string} commit.message - The commit message.
     * @returns {Object} An object containing the raw key, normalized text, and length.
     */
    _createFingerprint(commit) {
        const normalizedDiff = normalizeText(commit.diff || '');
        const normalizedMsg = normalizeText(commit.message || '');
        
        // The combined text represents the semantic payload of the commit
        const combinedText = `${normalizedMsg}\n\n${normalizedDiff}`;
        const exactHash = generateHash(combinedText);

        return {
            exactHash,
            normalizedText: combinedText,
            textLength: combinedText.length
        };
    }

    /**
     * Retrieves a cached LLM analysis for a given commit, using exact match
     * or semantic similarity fallback.
     * 
     * @param {Object} commit - The commit object to check.
     * @param {string} commit.diff - The git diff string.
     * @param {string} commit.message - The commit message.
     * @returns {Promise<Object|null>} The cached LLM result, or null if no match.
     */
    async get(commit) {
        if (!this.isInitialized) await this.initialize();
        if (!commit || (!commit.diff && !commit.message)) return null;

        const fingerprint = this._createFingerprint(commit);
        
        // 1. Attempt Exact Match (O(1))
        if (this.entries.has(fingerprint.exactHash)) {
            const entry = this.entries.get(fingerprint.exactHash);
            
            // Update LRU by removing and re-inserting
            this.entries.delete(fingerprint.exactHash);
            this.entries.set(fingerprint.exactHash, entry);
            
            this.stats.hitsExact++;
            return entry.llmResult;
        }

        // 2. Attempt Semantic Match (O(N) with length filtering)
        if (this.options.enableSemanticMatch && fingerprint.textLength > 0) {
            const semanticMatch = await this._findSemanticMatch(fingerprint);
            if (semanticMatch) {
                this.stats.hitsSemantic++;
                
                // Cache the exact hash of the new commit pointing to the semantic match result
                // to speed up future identical requests.
                await this.set(commit, semanticMatch.llmResult, true);
                
                return semanticMatch.llmResult;
            }
        }

        this.stats.misses++;
        return null;
    }

    /**
     * Stores an LLM analysis result in the cache.
     * 
     * @param {Object} commit - The commit object.
     * @param {string} commit.diff - The git diff string.
     * @param {string} commit.message - The commit message.
     * @param {Object} llmResult - The structured output from the LLM.
     * @param {boolean} [isSemanticAlias=false] - Internal flag to prevent re-normalizing if just aliasing.
     * @returns {Promise<void>}
     */
    async set(commit, llmResult, isSemanticAlias = false) {
        if (!this.isInitialized) await this.initialize();
        if (!commit || !llmResult) return;

        const fingerprint = this._createFingerprint(commit);

        const cacheEntry = {
            commitHash: commit.hash || 'unknown',
            exactHash: fingerprint.exactHash,
            normalizedText: fingerprint.normalizedText,
            textLength: fingerprint.textLength,
            llmResult: llmResult,
            timestamp: Date.now(),
            isAlias: isSemanticAlias
        };

        // If it already exists, delete it first to update its position for LRU
        if (this.entries.has(fingerprint.exactHash)) {
            this.entries.delete(fingerprint.exactHash);
        }

        this.entries.set(fingerprint.exactHash, cacheEntry);
        this.isDirty = true;

        this._enforceLRU();

        if (this.options.autoSave) {
            // Fire and forget, but handled safely via lock
            this._persist().catch(err => {
                console.error(`[GitHistoryLLM Cache] Background save failed: ${err.message}`);
                this.stats.errors++;
            });
        }
    }

    /**
     * Searches the cache for a semantically similar commit.
     * Uses length heuristics to drastically reduce the search space before
     * applying the more expensive Trigram Jaccard similarity.
     * 
     * @private
     * @param {Object} fingerprint - The fingerprint object of the target commit.
     * @returns {Promise<Object|null>} The matching cache entry or null.
     */
    async _findSemanticMatch(fingerprint) {
        const targetLen = fingerprint.textLength;
        const tolerance = this.options.lengthFilterTolerance;
        const minLen = targetLen * (1 - tolerance);
        const maxLen = targetLen * (1 + tolerance);

        let bestMatch = null;
        let highestScore = 0;

        // Iterate backwards (most recently added first)
        const entriesArray = Array.from(this.entries.values()).reverse();

        for (const entry of entriesArray) {
            // Skip entries that are just aliases to avoid cascading semantic drift
            if (entry.isAlias) continue;

            // 1. Length Heuristic Filter
            if (entry.textLength < minLen || entry.textLength > maxLen) {
                continue;
            }

            this.stats.totalComparisons++;

            // 2. Trigram Similarity Calculation
            const score = calculateSemanticSimilarity(fingerprint.normalizedText, entry.normalizedText);

            if (score >= this.options.similarityThreshold) {
                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = entry;
                    
                    // Short-circuit if it's an extremely high match to save time
                    if (score > 0.99) break; 
                }
            }
        }

        return bestMatch;
    }

    /**
     * Enforces the Least Recently Used (LRU) policy.
     * Removes the oldest entries if the cache exceeds maxEntries.
     * @private
     */
    _enforceLRU() {
        if (this.entries.size <= this.options.maxEntries) return;

        const entriesToRemove = this.entries.size - this.options.maxEntries;
        const iterator = this.entries.keys();

        for (let i = 0; i < entriesToRemove; i++) {
            const oldestKey = iterator.next().value;
            this.entries.delete(oldestKey);
            this.stats.evictions++;
            this.isDirty = true;
        }
    }

    /**
     * Persists the current in-memory cache to disk atomically.
     * Uses a temporary file and rename to prevent corruption during crashes.
     * @private
     * @returns {Promise<void>}
     */
    async _persist() {
        if (!this.isDirty || this._saveLock) return;
        
        this._saveLock = true;
        try {
            const exportData = {
                version: "1.0.0",
                lastUpdated: Date.now(),
                entries: Object.fromEntries(this.entries)
            };

            const tempPath = `${this.cacheFilePath}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(exportData, null, 2), 'utf8');
            
            // Atomic rename
            await fs.rename(tempPath, this.cacheFilePath);
            
            this.isDirty = false;
        } catch (err) {
            this.stats.errors++;
            throw new CacheError(`Failed to persist cache: ${err.message}`, 'PERSIST_FAILED');
        } finally {
            this._saveLock = false;
        }
    }

    /**
     * Flushes the cache completely, both in memory and on disk.
     * @returns {Promise<void>}
     */
    async clear() {
        this.entries.clear();
        this.stats = {
            hitsExact: 0,
            hitsSemantic: 0,
            misses: 0,
            evictions: 0,
            errors: 0,
            totalComparisons: 0
        };
        
        try {
            await fs.unlink(this.cacheFilePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw new CacheError(`Failed to delete cache file: ${err.message}`, 'CLEAR_FAILED');
            }
        }
        this.isDirty = false;
    }

    /**
     * Returns operational telemetry and statistics for the cache.
     * @returns {Object} Cache statistics.
     */
    getStats() {
        const totalRequests = this.stats.hitsExact + this.stats.hitsSemantic + this.stats.misses;
        const hitRate = totalRequests === 0 ? 0 : ((this.stats.hitsExact + this.stats.hitsSemantic) / totalRequests) * 100;

        return {
            ...this.stats,
            currentSize: this.entries.size,
            maxSize: this.options.maxEntries,
            hitRatePercentage: hitRate.toFixed(2)
        };
    }
}

// Export a singleton instance creator to maintain a shared cache across the app
let sharedCacheInstance = null;

module.exports = {
    SemanticCache,
    CacheError,
    
    /**
     * Gets or creates the shared singleton instance of the SemanticCache.
     * @param {Object} options - Configuration options (only applied on first call).
     * @returns {SemanticCache}
     */
    getInstance: (options = {}) => {
        if (!sharedCacheInstance) {
            sharedCacheInstance = new SemanticCache(options);
        }
        return sharedCacheInstance;
    },

    // Exported for unit testing purposes
    _utils: {
        generateHash,
        normalizeText,
        extractTrigrams,
        calculateSemanticSimilarity
    }
};