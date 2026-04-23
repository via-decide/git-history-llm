/**
 * @fileoverview Core Invariant Enforcement and Runtime Assertions
 * @module core/invariants
 * 
 * @description
 * This module provides a robust, zero-dependency runtime invariant enforcement system
 * for the Git History LLM pipeline. It ensures that critical system assumptions are
 * continuously verified during execution, preventing silent failures, data corruption,
 * and logic regressions.
 * 
 * Required Invariants Enforced:
 * 1. Schema Validity: Outputs must strictly adhere to defined schemas after the VERIFY phase.
 * 2. Determinism: Identical inputs must yield identical outputs before the STORE phase.
 * 3. Confidence Thresholds: AI outputs must meet or exceed a confidence threshold before ACCEPT.
 * 4. Cache Integrity: Only explicitly ACCEPTED outputs may be written to the cache.
 * 5. Fallback Integrity: Fallback mechanisms must still produce schema-compliant outputs.
 * 
 * @author Antigravity Synthesis Orchestrator (v3.0.0-beast)
 */

import { performance } from 'perf_hooks';
import { createHash } from 'crypto';

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base class for all invariant violations.
 * Extends the native Error class to provide structured context and telemetry.
 */
export class InvariantViolationError extends Error {
    /**
     * @param {string} message - Human-readable error description.
     * @param {string} code - Unique error code for programmatic handling.
     * @param {Object} context - Contextual data surrounding the violation.
     */
    constructor(message, code, context = {}) {
        super(`[INVARIANT VIOLATION: ${code}] ${message}`);
        this.name = this.constructor.name;
        this.code = code;
        this.context = context;
        this.timestamp = new Date().toISOString();
        
        // Capture stack trace, excluding the constructor call
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Serializes the error for logging or transmission.
     * @returns {Object} JSON-safe representation of the error.
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            context: this.context,
            timestamp: this.timestamp,
            stack: this.stack
        };
    }
}

export class SchemaViolationError extends InvariantViolationError {
    constructor(message, context) {
        super(message, 'ERR_SCHEMA_VIOLATION', context);
    }
}

export class DeterminismViolationError extends InvariantViolationError {
    constructor(message, context) {
        super(message, 'ERR_DETERMINISM_VIOLATION', context);
    }
}

export class ConfidenceViolationError extends InvariantViolationError {
    constructor(message, context) {
        super(message, 'ERR_CONFIDENCE_VIOLATION', context);
    }
}

export class CacheViolationError extends InvariantViolationError {
    constructor(message, context) {
        super(message, 'ERR_CACHE_VIOLATION', context);
    }
}

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

/**
 * System states representing the lifecycle of an LLM output processing pipeline.
 * @enum {string}
 */
export const PipelineState = {
    GENERATE: 'GENERATE',
    VERIFY: 'VERIFY',
    EVALUATE: 'EVALUATE',
    ACCEPT: 'ACCEPT',
    REJECT: 'REJECT',
    STORE: 'STORE',
    FALLBACK: 'FALLBACK'
};

/**
 * Output statuses representing the quality and readiness of an artifact.
 * @enum {string}
 */
export const OutputStatus = {
    PENDING: 'PENDING',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    FALLBACK_ACCEPTED: 'FALLBACK_ACCEPTED'
};

/**
 * Default configuration for the invariant enforcer.
 */
const DEFAULT_CONFIG = {
    strictMode: true,           // If true, violations throw errors. If false, they log warnings.
    defaultConfidenceThreshold: 0.85,
    enableTelemetry: true,      // Track performance and violation counts
    maxDepthForDeepEqual: 50    // Prevent infinite recursion in determinism checks
};

// ============================================================================
// UTILITY FUNCTIONS (Zero-Dependency Implementations)
// ============================================================================

/**
 * Computes a deterministic SHA-256 hash of a JavaScript object.
 * Useful for fast determinism checks and caching.
 * 
 * @param {any} obj - The object to hash.
 * @returns {string} Hexadecimal hash string.
 */
function hashObject(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj, Object.keys(obj || {}).sort());
    return createHash('sha256').update(str || '').digest('hex');
}

/**
 * Deep equality check for determinism validation.
 * Handles nested objects, arrays, dates, and primitives.
 * 
 * @param {any} a - First value.
 * @param {any} b - Second value.
 * @param {number} depth - Current recursion depth.
 * @param {number} maxDepth - Maximum allowed recursion depth.
 * @returns {boolean} True if deeply equal, false otherwise.
 */
function deepEqual(a, b, depth = 0, maxDepth = 50) {
    if (depth > maxDepth) throw new Error('Maximum depth exceeded in deepEqual');
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;

    if (typeof a === 'object') {
        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i], depth + 1, maxDepth)) return false;
            }
            return true;
        }

        if (a instanceof Date && b instanceof Date) {
            return a.getTime() === b.getTime();
        }

        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;

        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
            if (!deepEqual(a[key], b[key], depth + 1, maxDepth)) return false;
        }
        return true;
    }
    return false;
}

/**
 * Lightweight JSON Schema-like validator.
 * Validates a data object against a schema definition to enforce structural integrity.
 * 
 * @param {any} data - The data to validate.
 * @param {Object} schema - The schema definition.
 * @param {string} path - Current JSON path (for error reporting).
 * @returns {{ valid: boolean, errors: Array<string> }} Validation result.
 */
function validateSchema(data, schema, path = 'root') {
    const errors = [];

    if (!schema) {
        return { valid: true, errors };
    }

    // Type checking
    if (schema.type) {
        const actualType = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data);
        if (actualType !== schema.type) {
            errors.push(`Type mismatch at '${path}': expected ${schema.type}, got ${actualType}`);
            return { valid: false, errors };
        }
    }

    // Object property validation
    if (schema.type === 'object' && data !== null) {
        if (schema.required && Array.isArray(schema.required)) {
            for (const req of schema.required) {
                if (!(req in data)) {
                    errors.push(`Missing required property '${req}' at '${path}'`);
                }
            }
        }

        if (schema.properties) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in data) {
                    const childResult = validateSchema(data[key], propSchema, `${path}.${key}`);
                    errors.push(...childResult.errors);
                }
            }
        }
    }

    // Array item validation
    if (schema.type === 'array' && Array.isArray(data)) {
        if (schema.items) {
            for (let i = 0; i < data.length; i++) {
                const childResult = validateSchema(data[i], schema.items, `${path}[${i}]`);
                errors.push(...childResult.errors);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

// ============================================================================
// CORE INVARIANT ENFORCER
// ============================================================================

/**
 * The InvariantEnforcer manages the execution and telemetry of runtime assertions.
 * It is designed to be injected into pipeline stages to guarantee correctness.
 */
export class InvariantEnforcer {
    /**
     * @param {Object} config - Configuration options.
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.metrics = {
            checks: 0,
            violations: 0,
            executionTimeMs: 0
        };
    }

    /**
     * Internal method to handle violations based on strict mode configuration.
     * @private
     * @param {InvariantViolationError} error - The instantiated error.
     * @throws {InvariantViolationError} If strict mode is enabled.
     */
    _handleViolation(error) {
        this.metrics.violations++;
        if (this.config.strictMode) {
            throw error;
        } else {
            console.warn(`[INVARIANT WARNING] ${error.message}`, error.context);
        }
    }

    /**
     * Wraps execution with telemetry tracking.
     * @private
     * @param {Function} fn - The validation function to execute.
     */
    _track(fn) {
        if (!this.config.enableTelemetry) return fn();
        
        const start = performance.now();
        try {
            this.metrics.checks++;
            return fn();
        } finally {
            this.metrics.executionTimeMs += (performance.now() - start);
        }
    }

    /**
     * INVARIANT 1: Schema must be valid after VERIFY.
     * Ensures that the structural integrity of LLM outputs matches expected definitions.
     * 
     * @param {Object} data - The data payload to verify.
     * @param {Object} schema - The expected schema.
     * @param {Object} [context={}] - Additional context (e.g., commit hash, pipeline run ID).
     * @returns {boolean} True if valid.
     * @throws {SchemaViolationError} If validation fails and strict mode is on.
     */
    assertSchemaAfterVerify(data, schema, context = {}) {
        return this._track(() => {
            if (!data) {
                this._handleViolation(new SchemaViolationError('Data payload is null or undefined after VERIFY phase.', context));
                return false;
            }

            const { valid, errors } = validateSchema(data, schema);
            
            if (!valid) {
                this._handleViolation(new SchemaViolationError(
                    `Schema validation failed after VERIFY phase. Errors: ${errors.join('; ')}`,
                    { ...context, validationErrors: errors, providedDataPrefix: JSON.stringify(data).substring(0, 200) }
                ));
                return false;
            }
            return true;
        });
    }

    /**
     * INVARIANT 2: Determinism must pass before STORE.
     * Ensures that executing the same prompt/context twice yields semantically identical structured outputs.
     * 
     * @param {any} originalOutput - The initial output generated.
     * @param {any} reproducedOutput - The output generated during the determinism check.
     * @param {Object} [context={}] - Additional context.
     * @returns {boolean} True if deterministic.
     * @throws {DeterminismViolationError} If outputs differ and strict mode is on.
     */
    assertDeterminismBeforeStore(originalOutput, reproducedOutput, context = {}) {
        return this._track(() => {
            const isDeterministic = deepEqual(
                originalOutput, 
                reproducedOutput, 
                0, 
                this.config.maxDepthForDeepEqual
            );

            if (!isDeterministic) {
                const hash1 = hashObject(originalOutput);
                const hash2 = hashObject(reproducedOutput);
                
                this._handleViolation(new DeterminismViolationError(
                    'Determinism check failed before STORE phase. Outputs diverge.',
                    { 
                        ...context, 
                        originalHash: hash1, 
                        reproducedHash: hash2,
                        diffHint: 'Deep equality returned false. Review LLM temperature or seed settings.'
                    }
                ));
                return false;
            }
            return true;
        });
    }

    /**
     * INVARIANT 3: Confidence score >= threshold before ACCEPT.
     * Prevents low-quality, hallucinated, or uncertain outputs from entering the system.
     * 
     * @param {number} confidenceScore - The calculated confidence score (0.0 to 1.0).
     * @param {number} [threshold=this.config.defaultConfidenceThreshold] - The minimum acceptable score.
     * @param {Object} [context={}] - Additional context.
     * @returns {boolean} True if confidence is sufficient.
     * @throws {ConfidenceViolationError} If confidence is too low and strict mode is on.
     */
    assertConfidenceBeforeAccept(confidenceScore, threshold = this.config.defaultConfidenceThreshold, context = {}) {
        return this._track(() => {
            if (typeof confidenceScore !== 'number' || isNaN(confidenceScore)) {
                this._handleViolation(new ConfidenceViolationError(
                    `Invalid confidence score type: expected number, got ${typeof confidenceScore}`,
                    context
                ));
                return false;
            }

            if (confidenceScore < threshold) {
                this._handleViolation(new ConfidenceViolationError(
                    `Confidence score ${confidenceScore.toFixed(4)} is below the required threshold of ${threshold.toFixed(4)} before ACCEPT phase.`,
                    { ...context, score: confidenceScore, threshold }
                ));
                return false;
            }
            return true;
        });
    }

    /**
     * INVARIANT 4: Cache only stores ACCEPTED outputs.
     * Prevents poison-pill caching where pending, rejected, or transient states pollute the cache.
     * 
     * @param {string} status - The current status of the output artifact.
     * @param {Object} [context={}] - Additional context (e.g., cache key).
     * @returns {boolean} True if status permits caching.
     * @throws {CacheViolationError} If status is invalid for caching and strict mode is on.
     */
    assertCacheStoresOnlyAccepted(status, context = {}) {
        return this._track(() => {
            const allowedStatuses = [OutputStatus.ACCEPTED, OutputStatus.FALLBACK_ACCEPTED];
            
            if (!allowedStatuses.includes(status)) {
                this._handleViolation(new CacheViolationError(
                    `Attempted to store artifact with status '${status}' in cache. Only ACCEPTED statuses are permitted.`,
                    { ...context, attemptedStatus: status, allowedStatuses }
                ));
                return false;
            }
            return true;
        });
    }

    /**
     * INVARIANT 5: Fallback outputs must still pass schema.
     * Ensures that when the primary LLM fails and a deterministic fallback is used,
     * the fallback data does not break downstream consumers.
     * 
     * @param {Object} fallbackData - The data generated by the fallback mechanism.
     * @param {Object} schema - The expected schema.
     * @param {Object} [context={}] - Additional context.
     * @returns {boolean} True if fallback is valid.
     * @throws {SchemaViolationError} If fallback validation fails and strict mode is on.
     */
    assertFallbackPassesSchema(fallbackData, schema, context = {}) {
        return this._track(() => {
            const { valid, errors } = validateSchema(fallbackData, schema);
            
            if (!valid) {
                this._handleViolation(new SchemaViolationError(
                    `Fallback mechanism generated data that violates the schema. Errors: ${errors.join('; ')}`,
                    { ...context, validationErrors: errors, isFallback: true }
                ));
                return false;
            }
            return true;
        });
    }

    /**
     * Retrieves the current telemetry metrics for the invariant enforcer.
     * @returns {Object} Metrics object.
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Resets telemetry metrics.
     */
    resetMetrics() {
        this.metrics = { checks: 0, violations: 0, executionTimeMs: 0 };
    }
}

// ============================================================================
// SINGLETON EXPORT & MIDDLEWARE FACTORIES
// ============================================================================

/**
 * Global singleton instance of the InvariantEnforcer for standard usage.
 * @type {InvariantEnforcer}
 */
export const globalInvariants = new InvariantEnforcer();

/**
 * Higher-order function (Middleware) to automatically wrap asynchronous pipeline functions
 * with schema verification.
 * 
 * @param {Function} asyncFn - The async function generating data.
 * @param {Object} schema - The schema to enforce on the output.
 * @returns {Function} Wrapped async function that throws SchemaViolationError if invalid.
 */
export function withSchemaEnforcement(asyncFn, schema) {
    return async async function(...args) {
        const result = await asyncFn(...args);
        globalInvariants.assertSchemaAfterVerify(result, schema, { functionName: asyncFn.name });
        return result;
    };
}

/**
 * Higher-order function to enforce cache invariants on store operations.
 * 
 * @param {Function} cacheStoreFn - The async function storing data to cache.
 * @returns {Function} Wrapped cache function.
 */
export function withCacheEnforcement(cacheStoreFn) {
    return async async function(key, data, status, ...args) {
        globalInvariants.assertCacheStoresOnlyAccepted(status, { key });
        return await cacheStoreFn(key, data, status, ...args);
    };
}