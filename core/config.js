/**
 * @fileoverview Centralized Configuration Management and Runtime Guardrails.
 * @module core/config
 * 
 * This module defines, loads, validates, and freezes all configuration parameters
 * for the Git History LLM pipeline. It ensures that the system boots in a valid
 * state and enforces runtime guardrails to prevent misconfiguration failures.
 * 
 * Features:
 * - Environment variable mapping with sensible defaults.
 * - Strict type checking and bounds validation.
 * - Deep immutability (freezing) to prevent runtime mutation.
 * - Safe configuration dumping (secrets masking).
 */

const process = require('process');
const path = require('path');
const fs = require('fs');

/**
 * Custom error class for configuration validation failures.
 * Ensures that misconfigurations are easily identifiable in logs.
 */
class ConfigValidationError extends Error {
    /**
     * @param {string} message - Detailed error message describing the validation failure.
     * @param {string} [parameter] - The specific configuration parameter that failed validation.
     */
    constructor(message, parameter = 'UNKNOWN_PARAM') {
        super(`[ConfigValidationError] Parameter '${parameter}': ${message}`);
        this.name = 'ConfigValidationError';
        this.parameter = parameter;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Utility functions for parsing and validating configuration values.
 * These act as the primary guardrails during the configuration load phase.
 */
const Validators = {
    /**
     * Parses and validates a numeric configuration value.
     * @param {string|number|undefined} value - The raw value from environment or input.
     * @param {number} defaultValue - The fallback value if input is undefined.
     * @param {number} min - The minimum allowed value (inclusive).
     * @param {number} max - The maximum allowed value (inclusive).
     * @param {string} paramName - The name of the parameter for error reporting.
     * @returns {number} The validated numeric value.
     * @throws {ConfigValidationError} If the value is invalid or out of bounds.
     */
    parseNumber(value, defaultValue, min, max, paramName) {
        if (value === undefined || value === null || value === '') {
            return defaultValue;
        }
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
            throw new ConfigValidationError(`Must be a valid number. Received: ${value}`, paramName);
        }
        if (parsed < min || parsed > max) {
            throw new ConfigValidationError(`Value ${parsed} is out of bounds. Must be between ${min} and ${max}.`, paramName);
        }
        return parsed;
    },

    /**
     * Parses and validates a boolean configuration value.
     * @param {string|boolean|undefined} value - The raw value.
     * @param {boolean} defaultValue - The fallback value.
     * @param {string} paramName - The name of the parameter.
     * @returns {boolean} The validated boolean value.
     */
    parseBoolean(value, defaultValue, paramName) {
        if (value === undefined || value === null || value === '') {
            return defaultValue;
        }
        if (typeof value === 'boolean') return value;
        const lower = String(value).toLowerCase().trim();
        if (['true', '1', 'yes', 'on'].includes(lower)) return true;
        if (['false', '0', 'no', 'off'].includes(lower)) return false;
        throw new ConfigValidationError(`Must be a boolean-like value (true/false, 1/0). Received: ${value}`, paramName);
    },

    /**
     * Parses and validates a string configuration value, optionally against an enum.
     * @param {string|undefined} value - The raw string value.
     * @param {string} defaultValue - The fallback value.
     * @param {string[]} [allowedValues] - Optional array of strictly allowed strings.
     * @param {string} paramName - The name of the parameter.
     * @returns {string} The validated string.
     */
    parseString(value, defaultValue, allowedValues, paramName) {
        const val = (value === undefined || value === null || value === '') ? defaultValue : String(value).trim();
        if (allowedValues && Array.isArray(allowedValues) && !allowedValues.includes(val)) {
            throw new ConfigValidationError(`Must be one of [${allowedValues.join(', ')}]. Received: ${val}`, paramName);
        }
        return val;
    },

    /**
     * Validates that a required string is present and not empty.
     * @param {string|undefined} value - The raw string value.
     * @param {string} paramName - The name of the parameter.
     * @returns {string} The validated string.
     */
    requireString(value, paramName) {
        if (!value || String(value).trim() === '') {
            throw new ConfigValidationError(`Required parameter is missing or empty.`, paramName);
        }
        return String(value).trim();
    }
};

/**
 * Recursively freezes an object to enforce deep immutability.
 * @param {Object} obj - The object to freeze.
 * @returns {Object} The deeply frozen object.
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    Object.keys(obj).forEach(prop => {
        const val = obj[prop];
        if (typeof val === 'object' && val !== null && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    });
    return Object.freeze(obj);
}

/**
 * Core Configuration Manager for Git History LLM.
 * Responsible for assembling the configuration schema, applying validators,
 * and exposing a safe, immutable configuration object.
 */
class ConfigManager {
    constructor() {
        /**
         * @type {Object|null}
         * @private
         */
        this._config = null;
    }

    /**
     * Loads, validates, and freezes the configuration from environment variables.
     * @param {Object} env - The environment object (defaults to process.env).
     * @returns {Object} The validated and frozen configuration object.
     */
    load(env = process.env) {
        try {
            const rawConfig = {
                /**
                 * LLM API and Execution Boundaries
                 * Guardrails for interacting with external AI models.
                 */
                llm: {
                    provider: Validators.parseString(env.GIT_LLM_PROVIDER, 'gemini', ['gemini', 'openai', 'anthropic', 'local'], 'GIT_LLM_PROVIDER'),
                    apiKey: env.GIT_LLM_API_KEY || '', // Loaded but not strictly required at boot (might be injected later), but validated on use.
                    model: Validators.parseString(env.GIT_LLM_MODEL, 'gemini-1.5-pro', null, 'GIT_LLM_MODEL'),
                    
                    // Token Budgeting Guardrails
                    tokenBudget: Validators.parseNumber(env.GIT_LLM_TOKEN_BUDGET, 100000, 1000, 100000000, 'GIT_LLM_TOKEN_BUDGET'),
                    maxTokensPerRequest: Validators.parseNumber(env.GIT_LLM_MAX_TOKENS, 8192, 128, 128000, 'GIT_LLM_MAX_TOKENS'),
                    temperature: Validators.parseNumber(env.GIT_LLM_TEMPERATURE, 0.2, 0.0, 2.0, 'GIT_LLM_TEMPERATURE'),
                    
                    // Rate Limiting Guardrails
                    rateLimits: {
                        requestsPerMinute: Validators.parseNumber(env.GIT_LLM_RPM, 50, 1, 1000, 'GIT_LLM_RPM'),
                        tokensPerMinute: Validators.parseNumber(env.GIT_LLM_TPM, 200000, 1000, 10000000, 'GIT_LLM_TPM')
                    },
                    
                    // Resiliency and Retry Guardrails
                    retry: {
                        count: Validators.parseNumber(env.GIT_LLM_RETRY_COUNT, 3, 0, 10, 'GIT_LLM_RETRY_COUNT'),
                        baseBackoffMs: Validators.parseNumber(env.GIT_LLM_RETRY_BACKOFF_MS, 1000, 100, 60000, 'GIT_LLM_RETRY_BACKOFF_MS'),
                        maxBackoffMs: Validators.parseNumber(env.GIT_LLM_MAX_BACKOFF_MS, 30000, 1000, 120000, 'GIT_LLM_MAX_BACKOFF_MS')
                    }
                },

                /**
                 * Analysis and Reasoning Thresholds
                 * Mathematical guardrails for categorization and insight generation.
                 */
                thresholds: {
                    // Minimum confidence required to auto-categorize a commit without human review
                    confidenceThreshold: Validators.parseNumber(env.GIT_LLM_CONFIDENCE_THRESHOLD, 0.85, 0.1, 1.0, 'GIT_LLM_CONFIDENCE_THRESHOLD'),
                    // Threshold for grouping similar commits or detecting duplicate efforts
                    similarityThreshold: Validators.parseNumber(env.GIT_LLM_SIMILARITY_THRESHOLD, 0.90, 0.1, 1.0, 'GIT_LLM_SIMILARITY_THRESHOLD'),
                    // Strictness of the intent deconstruction pipeline
                    categorizationStrictness: Validators.parseNumber(env.GIT_LLM_CATEGORIZATION_STRICTNESS, 0.95, 0.5, 1.0, 'GIT_LLM_CATEGORIZATION_STRICTNESS')
                },

                /**
                 * Git Repository Constraints
                 * Guardrails to prevent memory exhaustion when parsing massive repositories.
                 */
                git: {
                    repoPath: Validators.parseString(env.GIT_LLM_REPO_PATH, process.cwd(), null, 'GIT_LLM_REPO_PATH'),
                    maxCommitsPerBatch: Validators.parseNumber(env.GIT_LLM_MAX_COMMITS_BATCH, 100, 1, 5000, 'GIT_LLM_MAX_COMMITS_BATCH'),
                    maxDiffSizeKb: Validators.parseNumber(env.GIT_LLM_MAX_DIFF_KB, 500, 10, 50000, 'GIT_LLM_MAX_DIFF_KB'),
                    includeDiffs: Validators.parseBoolean(env.GIT_LLM_INCLUDE_DIFFS, true, 'GIT_LLM_INCLUDE_DIFFS'),
                    ignorePaths: Validators.parseString(env.GIT_LLM_IGNORE_PATHS, 'node_modules,.git,dist,build', null, 'GIT_LLM_IGNORE_PATHS').split(',').map(p => p.trim())
                },

                /**
                 * System and Orchestration Settings
                 * Runtime behavioral configurations.
                 */
                system: {
                    logLevel: Validators.parseString(env.GIT_LLM_LOG_LEVEL, 'info', ['debug', 'info', 'warn', 'error', 'fatal'], 'GIT_LLM_LOG_LEVEL'),
                    concurrency: Validators.parseNumber(env.GIT_LLM_CONCURRENCY, 4, 1, 64, 'GIT_LLM_CONCURRENCY'),
                    cacheEnabled: Validators.parseBoolean(env.GIT_LLM_CACHE_ENABLED, true, 'GIT_LLM_CACHE_ENABLED'),
                    cacheTtlSeconds: Validators.parseNumber(env.GIT_LLM_CACHE_TTL, 86400, 60, 2592000, 'GIT_LLM_CACHE_TTL'), // Default 24 hours
                    outputFormat: Validators.parseString(env.GIT_LLM_OUTPUT_FORMAT, 'json', ['json', 'markdown', 'console'], 'GIT_LLM_OUTPUT_FORMAT')
                }
            };

            // Cross-parameter validation (Complex Guardrails)
            this._validateCrossParameters(rawConfig);

            // Deep freeze to prevent runtime mutation
            this._config = deepFreeze(rawConfig);
            
            return this._config;

        } catch (error) {
            console.error('\n[FATAL] Git History LLM Configuration Boot Failure');
            console.error('--------------------------------------------------');
            console.error(error.message);
            console.error('--------------------------------------------------\n');
            // Re-throw to prevent application startup with invalid state
            throw error;
        }
    }

    /**
     * Executes complex validations that depend on multiple configuration parameters.
     * @param {Object} config - The raw, unfrozen configuration object.
     * @private
     */
    _validateCrossParameters(config) {
        if (config.llm.retry.baseBackoffMs >= config.llm.retry.maxBackoffMs) {
            throw new ConfigValidationError(
                `Base backoff (${config.llm.retry.baseBackoffMs}ms) must be strictly less than max backoff (${config.llm.retry.maxBackoffMs}ms).`,
                'GIT_LLM_RETRY_BACKOFF_MS'
            );
        }

        if (config.thresholds.confidenceThreshold < config.thresholds.similarityThreshold) {
            // While not strictly a fatal error in all domains, for our pipeline, 
            // similarity grouping should be at least as strict as base confidence.
            // Adjusting automatically or logging a loud warning.
            // For strict guardrails, we enforce it.
            throw new ConfigValidationError(
                `Similarity threshold (${config.thresholds.similarityThreshold}) cannot be greater than confidence threshold (${config.thresholds.confidenceThreshold}) to prevent logic loops.`,
                'GIT_LLM_SIMILARITY_THRESHOLD'
            );
        }
    }

    /**
     * Retrieves the active configuration. Loads it if not already loaded.
     * @returns {Object} The deeply frozen configuration object.
     */
    get() {
        if (!this._config) {
            return this.load();
        }
        return this._config;
    }

    /**
     * Returns a safe, stringified version of the configuration suitable for logging.
     * Masks sensitive information such as API keys.
     * @returns {string} JSON string of the safe configuration.
     */
    dumpSafe() {
        const config = this.get();
        const safeConfig = JSON.parse(JSON.stringify(config)); // Deep clone for masking
        
        if (safeConfig.llm && safeConfig.llm.apiKey) {
            const keyLen = safeConfig.llm.apiKey.length;
            if (keyLen > 8) {
                safeConfig.llm.apiKey = `${safeConfig.llm.apiKey.substring(0, 4)}...${safeConfig.llm.apiKey.substring(keyLen - 4)}`;
            } else {
                safeConfig.llm.apiKey = '***MASKED***';
            }
        }
        
        return JSON.stringify(safeConfig, null, 2);
    }

    /**
     * Validates a runtime state against the configured guardrails.
     * Call this before executing expensive API calls or memory-intensive git operations.
     * @param {Object} state - The current runtime state to validate.
     * @param {number} [state.consumedTokens] - Tokens used so far in the current session.
     * @param {number} [state.diffSizeKb] - The size of the git diff about to be processed.
     * @throws {Error} If the state violates configuration guardrails.
     */
    enforceRuntimeGuardrails(state) {
        const config = this.get();

        if (state.consumedTokens !== undefined) {
            if (state.consumedTokens > config.llm.tokenBudget) {
                throw new Error(`[Runtime Guardrail] Token budget exceeded. Consumed: ${state.consumedTokens}, Budget: ${config.llm.tokenBudget}`);
            }
        }

        if (state.diffSizeKb !== undefined) {
            if (state.diffSizeKb > config.git.maxDiffSizeKb) {
                throw new Error(`[Runtime Guardrail] Git diff size exceeds maximum allowed. Size: ${state.diffSizeKb}KB, Max: ${config.git.maxDiffSizeKb}KB`);
            }
        }
    }
}

// Export a singleton instance of the ConfigManager
const configManager = new ConfigManager();

// Pre-load the configuration immediately to fail fast if environment is misconfigured
configManager.load();

module.exports = {
    config: configManager.get(),
    ConfigManager,
    ConfigValidationError,
    dumpSafeConfig: () => configManager.dumpSafe(),
    enforceGuardrails: (state) => configManager.enforceRuntimeGuardrails(state)
};