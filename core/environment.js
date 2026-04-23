/**
 * @fileoverview Environment Fingerprinting and Execution Sealing Module.
 * 
 * This module is responsible for capturing the exact state of the execution environment,
 * generating a cryptographic fingerprint, and providing mechanisms to "seal" an execution.
 * It detects environment drift across different runs or systems to guarantee reproducibility,
 * which is critical for deterministic LLM pipeline execution and history reasoning.
 * 
 * Features:
 * - Comprehensive system and runtime fingerprinting (OS, Node.js, V8, hardware).
 * - Cryptographic hashing of environment state.
 * - Secure environment variable sanitization (redacting secrets).
 * - Execution sealing (saving the state to a lockfile).
 * - Advanced drift detection with severity categorization (CRITICAL, WARNING, INFO).
 * 
 * @module core/environment
 * @requires os
 * @requires crypto
 * @requires fs
 * @requires path
 * @requires child_process
 */

'use strict';

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

/**
 * Patterns used to identify and redact sensitive environment variables.
 * We do not want API keys or tokens leaking into our environment seals.
 * @type {RegExp[]}
 */
const SENSITIVE_ENV_PATTERNS = [
    /key/i,
    /token/i,
    /secret/i,
    /password/i,
    /auth/i,
    /credential/i,
    /cert/i,
    /session/i
];

/**
 * Severity levels for detected environment drift.
 * @enum {string}
 */
const DRIFT_SEVERITY = {
    CRITICAL: 'CRITICAL', // Execution should halt (e.g., different Node major version, different architecture)
    WARNING: 'WARNING',   // Execution can proceed but might behave differently (e.g., different OS minor version, memory change)
    INFO: 'INFO',         // Informational changes (e.g., uptime, non-critical env vars)
    NONE: 'NONE'          // Complete match
};

/**
 * Default configuration for the Environment Manager.
 */
const DEFAULT_CONFIG = {
    sealFilename: '.env-seal.json',
    algorithm: 'sha256',
    strictMode: false, // If true, CRITICAL drift throws an error
    includeGitRevision: true,
    includeDependencies: true
};

// ============================================================================
// UTILITY CLASSES
// ============================================================================

/**
 * Generates a comprehensive snapshot of the current execution environment.
 */
class FingerprintGenerator {
    /**
     * @param {Object} options - Generator options.
     */
    constructor(options = {}) {
        this.options = { ...DEFAULT_CONFIG, ...options };
    }

    /**
     * Gathers hardware and OS level information.
     * @returns {Object} System information object.
     */
    getSystemInfo() {
        const cpus = os.cpus();
        return {
            platform: os.platform(),
            release: os.release(),
            architecture: os.arch(),
            cpuModel: cpus.length > 0 ? cpus[0].model : 'Unknown',
            cpuCores: cpus.length,
            totalMemoryBytes: os.totalmem(),
            endianness: os.endianness()
        };
    }

    /**
     * Gathers Node.js runtime information.
     * @returns {Object} Node environment details.
     */
    getNodeInfo() {
        return {
            version: process.version,
            versions: process.versions, // Includes v8, uv, zlib, etc.
            execArgs: process.execArgv,
            arch: process.arch,
            platform: process.platform
        };
    }

    /**
     * Sanitizes environment variables, removing sensitive data.
     * @returns {Object} Sanitized environment variables.
     */
    getSanitizedEnv() {
        const sanitized = {};
        for (const [key, value] of Object.entries(process.env)) {
            const isSensitive = SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(key));
            if (isSensitive) {
                sanitized[key] = '[REDACTED]';
            } else {
                sanitized[key] = value;
            }
        }
        // Sort keys to ensure deterministic hashing
        return Object.keys(sanitized).sort().reduce((acc, key) => {
            acc[key] = sanitized[key];
            return acc;
        }, {});
    }

    /**
     * Extracts project dependency versions if a package.json exists.
     * @returns {Object|null} Dependencies map or null if not found.
     */
    getProjectInfo() {
        if (!this.options.includeDependencies) return null;

        try {
            const pkgPath = path.resolve(process.cwd(), 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                return {
                    name: pkg.name || 'unknown',
                    version: pkg.version || 'unknown',
                    dependencies: pkg.dependencies || {},
                    devDependencies: pkg.devDependencies || {}
                };
            }
        } catch (error) {
            console.warn('[Environment] Failed to read project info:', error.message);
        }
        return null;
    }

    /**
     * Retrieves the current Git revision hash if applicable.
     * @returns {string|null} Git SHA or null.
     */
    getGitRevision() {
        if (!this.options.includeGitRevision) return null;

        try {
            const rev = execSync('git rev-parse HEAD', { 
                stdio: ['ignore', 'pipe', 'ignore'],
                encoding: 'utf8' 
            }).trim();
            return rev;
        } catch (error) {
            // Not a git repository or git not installed
            return null;
        }
    }

    /**
     * Builds the complete environment fingerprint object.
     * @returns {Object} The complete fingerprint payload.
     */
    build() {
        const payload = {
            timestamp: new Date().toISOString(),
            system: this.getSystemInfo(),
            runtime: this.getNodeInfo(),
            env: this.getSanitizedEnv(),
            project: this.getProjectInfo(),
            gitRevision: this.getGitRevision()
        };

        const hash = crypto.createHash(this.options.algorithm)
            .update(JSON.stringify(payload))
            .digest('hex');

        return {
            hash,
            algorithm: this.options.algorithm,
            payload
        };
    }
}

/**
 * Analyzes differences between two environment fingerprints to detect drift.
 */
class DriftAnalyzer {
    /**
     * Compares two objects deeply and records differences.
     * @param {Object} current - The current environment payload.
     * @param {Object} sealed - The sealed (baseline) environment payload.
     * @param {string} path - Current object path (used for recursion).
     * @returns {Array<Object>} Array of difference objects.
     */
    static findDifferences(current, sealed, path = '') {
        let diffs = [];

        // Handle nulls and undefined
        if (current === null || sealed === null || current === undefined || sealed === undefined) {
            if (current !== sealed) {
                diffs.push({ path, current, sealed });
            }
            return diffs;
        }

        // Handle primitives
        if (typeof current !== 'object' || typeof sealed !== 'object') {
            if (current !== sealed) {
                diffs.push({ path, current, sealed });
            }
            return diffs;
        }

        const allKeys = new Set([...Object.keys(current), ...Object.keys(sealed)]);

        for (const key of allKeys) {
            const currentPath = path ? `${path}.${key}` : key;
            
            // Skip timestamp as it will always drift
            if (currentPath === 'timestamp') continue;

            if (!(key in sealed)) {
                diffs.push({ path: currentPath, type: 'ADDED', current: current[key] });
            } else if (!(key in current)) {
                diffs.push({ path: currentPath, type: 'REMOVED', sealed: sealed[key] });
            } else {
                diffs = diffs.concat(this.findDifferences(current[key], sealed[key], currentPath));
            }
        }

        return diffs;
    }

    /**
     * Evaluates the severity of a specific difference.
     * @param {Object} diff - The difference object.
     * @returns {string} The severity level (from DRIFT_SEVERITY).
     */
    static evaluateSeverity(diff) {
        const { path } = diff;

        // Critical drifts: Architecture, Node major version, Platform
        if (path.startsWith('system.platform') || 
            path.startsWith('system.architecture') ||
            path === 'runtime.version' ||
            path === 'runtime.versions.v8') {
            return DRIFT_SEVERITY.CRITICAL;
        }

        // Warning drifts: Dependencies, CPU cores, Memory (large variance), Git revision
        if (path.startsWith('project.dependencies') ||
            path.startsWith('system.cpuCores') ||
            path === 'gitRevision') {
            return DRIFT_SEVERITY.WARNING;
        }

        // Memory heuristic: Only warn if difference is > 1GB
        if (path === 'system.totalMemoryBytes') {
            const memDiff = Math.abs((diff.current || 0) - (diff.sealed || 0));
            if (memDiff > 1024 * 1024 * 1024) {
                return DRIFT_SEVERITY.WARNING;
            }
            return DRIFT_SEVERITY.INFO;
        }

        // Info drifts: Environment variables, minor OS release changes
        return DRIFT_SEVERITY.INFO;
    }

    /**
     * Analyzes drift between current and sealed fingerprints.
     * @param {Object} currentFingerprint - Freshly generated fingerprint.
     * @param {Object} sealedFingerprint - Fingerprint loaded from seal file.
     * @returns {Object} Drift analysis report.
     */
    static analyze(currentFingerprint, sealedFingerprint) {
        if (currentFingerprint.hash === sealedFingerprint.hash) {
            return { hasDrift: false, severity: DRIFT_SEVERITY.NONE, details: [] };
        }

        const rawDiffs = this.findDifferences(currentFingerprint.payload, sealedFingerprint.payload);
        
        let highestSeverity = DRIFT_SEVERITY.NONE;
        const details = rawDiffs.map(diff => {
            const severity = this.evaluateSeverity(diff);
            
            // Upgrade overall severity if needed
            if (severity === DRIFT_SEVERITY.CRITICAL) highestSeverity = DRIFT_SEVERITY.CRITICAL;
            else if (severity === DRIFT_SEVERITY.WARNING && highestSeverity !== DRIFT_SEVERITY.CRITICAL) highestSeverity = DRIFT_SEVERITY.WARNING;
            else if (severity === DRIFT_SEVERITY.INFO && highestSeverity === DRIFT_SEVERITY.NONE) highestSeverity = DRIFT_SEVERITY.INFO;

            return { ...diff, severity };
        });

        return {
            hasDrift: details.length > 0,
            severity: highestSeverity,
            details
        };
    }
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * EnvironmentManager orchestrates fingerprinting, sealing, and drift detection.
 * Use this class to ensure reproducible execution environments.
 */
class EnvironmentManager {
    /**
     * Initializes the EnvironmentManager.
     * @param {Object} config - Configuration overrides.
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.generator = new FingerprintGenerator(this.config);
    }

    /**
     * Generates a new environment fingerprint.
     * @returns {Object} The complete fingerprint.
     */
    generateFingerprint() {
        return this.generator.build();
    }

    /**
     * Captures the current environment state and saves it to a seal file.
     * This creates a baseline for future executions.
     * @param {string} [customPath] - Optional custom path for the seal file.
     * @returns {Object} The generated fingerprint that was sealed.
     * @throws {Error} If writing the seal file fails.
     */
    seal(customPath = null) {
        const targetPath = customPath || path.resolve(process.cwd(), this.config.sealFilename);
        const fingerprint = this.generateFingerprint();

        try {
            fs.writeFileSync(targetPath, JSON.stringify(fingerprint, null, 2), 'utf8');
            console.log(`[Environment] Execution sealed successfully at ${targetPath}`);
            return fingerprint;
        } catch (error) {
            throw new Error(`Failed to seal execution environment: ${error.message}`);
        }
    }

    /**
     * Reads a sealed fingerprint from disk.
     * @param {string} targetPath - Path to the seal file.
     * @returns {Object|null} The parsed fingerprint, or null if it doesn't exist.
     */
    loadSeal(targetPath) {
        if (!fs.existsSync(targetPath)) return null;
        try {
            const raw = fs.readFileSync(targetPath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            console.error(`[Environment] Corrupted seal file at ${targetPath}:`, error.message);
            return null;
        }
    }

    /**
     * Verifies the current environment against a previously sealed baseline.
     * Detects drift and optionally throws an error if strict mode is enabled and drift is critical.
     * 
     * @param {string} [customPath] - Optional custom path for the seal file.
     * @param {boolean} [strictOverride] - Override the strictMode config for this call.
     * @returns {Object} Verification report including drift analysis.
     * @throws {Error} If strict mode is on and CRITICAL drift is detected.
     */
    verify(customPath = null, strictOverride = null) {
        const targetPath = customPath || path.resolve(process.cwd(), this.config.sealFilename);
        const isStrict = strictOverride !== null ? strictOverride : this.config.strictMode;

        const sealed = this.loadSeal(targetPath);
        if (!sealed) {
            return {
                verified: false,
                error: 'No seal file found. Cannot verify environment.',
                drift: null
            };
        }

        const current = this.generateFingerprint();
        const driftReport = DriftAnalyzer.analyze(current, sealed);

        if (driftReport.hasDrift) {
            console.warn(`[Environment] Drift detected! Severity: ${driftReport.severity}`);
            
            if (isStrict && driftReport.severity === DRIFT_SEVERITY.CRITICAL) {
                const criticalDiffs = driftReport.details.filter(d => d.severity === DRIFT_SEVERITY.CRITICAL);
                throw new Error(
                    `CRITICAL Environment Drift Detected. Execution halted in strict mode.\n` +
                    `Differences: ${JSON.stringify(criticalDiffs, null, 2)}`
                );
            }
        } else {
            console.log('[Environment] Verification passed. No drift detected.');
        }

        return {
            verified: !driftReport.hasDrift || driftReport.severity !== DRIFT_SEVERITY.CRITICAL,
            drift: driftReport,
            currentHash: current.hash,
            sealedHash: sealed.hash
        };
    }

    /**
     * Utility to completely reset/delete the current environment seal.
     * @param {string} [customPath] - Optional custom path to the seal file.
     * @returns {boolean} True if deleted, false if it didn't exist or failed.
     */
    breakSeal(customPath = null) {
        const targetPath = customPath || path.resolve(process.cwd(), this.config.sealFilename);
        if (fs.existsSync(targetPath)) {
            try {
                fs.unlinkSync(targetPath);
                console.log(`[Environment] Seal broken (deleted) at ${targetPath}`);
                return true;
            } catch (error) {
                console.error(`[Environment] Failed to break seal: ${error.message}`);
                return false;
            }
        }
        return false;
    }
}

module.exports = {
    EnvironmentManager,
    FingerprintGenerator,
    DriftAnalyzer,
    DRIFT_SEVERITY,
    DEFAULT_CONFIG
};