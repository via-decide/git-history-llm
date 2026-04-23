/**
 * @fileoverview Control Plane Interface for Git History LLM.
 * @module core/control-plane
 * @description Provides a safe, read-only control plane interface for system introspection.
 * This module enables external visibility into the core execution engine, state management,
 * and performance metrics without risking execution integrity or allowing state mutation.
 * 
 * Features:
 * - Immutable state exposure via deep freezing and cloning.
 * - Redaction of sensitive information (e.g., API keys, tokens) from introspected state.
 * - Comprehensive performance metric aggregation.
 * - Audit logging of all introspection queries.
 */

const { EventEmitter } = require('events');
const { performance, PerformanceObserver } = require('perf_hooks');
const os = require('os');
const crypto = require('crypto');

// ============================================================================
// CUSTOM ERRORS
// ============================================================================

/**
 * Custom error class for Control Plane specific exceptions.
 * @extends Error
 */
class ControlPlaneError extends Error {
    /**
     * @param {string} message - Error description.
     * @param {string} code - Error code for programmatic handling.
     * @param {Object} [details] - Additional error context.
     */
    constructor(message, code, details = {}) {
        super(message);
        this.name = 'ControlPlaneError';
        this.code = code || 'CONTROL_PLANE_FAULT';
        this.details = details;
        this.timestamp = new Date().toISOString();
        Error.captureStackTrace(this, this.constructor);
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Deep freezes an object to ensure strict immutability.
 * Protects the core system state from accidental or malicious mutation by callers.
 * 
 * @param {Object} obj - The object to freeze.
 * @returns {Object} The deeply frozen object.
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Retrieve the property names defined on object
    const propNames = Object.getOwnPropertyNames(obj);

    // Freeze properties before freezing self
    for (const name of propNames) {
        const value = obj[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    }

    return Object.freeze(obj);
}

/**
 * Creates a deep clone of an object to break memory references.
 * Uses structuredClone if available, otherwise falls back to JSON serialization.
 * 
 * @param {Object} obj - The object to clone.
 * @returns {Object} A completely detached clone of the object.
 */
function safeClone(obj) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(obj);
        } catch (e) {
            // Fallback if structuredClone fails (e.g., on functions or DOM nodes, though unexpected here)
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Redacts sensitive keys from a state object to prevent leaking credentials.
 * 
 * @param {Object} obj - The object to sanitize.
 * @param {Array<string>} sensitiveKeys - Keys to redact.
 * @returns {Object} The sanitized object.
 */
function sanitizeState(obj, sensitiveKeys = ['apiKey', 'token', 'secret', 'password', 'authorization']) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    const sanitized = Array.isArray(obj) ? [] : {};

    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        const isSensitive = sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey));

        if (isSensitive) {
            sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeState(value, sensitiveKeys);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

// ============================================================================
// CONTROL PLANE IMPLEMENTATION
// ============================================================================

/**
 * The ControlPlane class serves as the read-only governance and monitoring layer.
 * It interfaces with the core SystemRegistry or StateManager to extract, sanitize,
 * and deliver system metrics and states securely.
 */
class ControlPlane extends EventEmitter {
    /**
     * Initializes the Control Plane.
     * 
     * @param {Object} systemRegistry - The core system registry/state manager.
     * @param {Object} [options] - Configuration options.
     * @param {boolean} [options.enableAuditLog=true] - Whether to log introspection queries.
     * @param {Array<string>} [options.customRedactKeys=[]] - Additional keys to redact.
     */
    constructor(systemRegistry, options = {}) {
        super();
        
        if (!systemRegistry) {
            throw new ControlPlaneError(
                'SystemRegistry is required to initialize the Control Plane.',
                'MISSING_REGISTRY'
            );
        }

        this._registry = systemRegistry;
        this._options = {
            enableAuditLog: true,
            customRedactKeys: [],
            ...options
        };

        this._sensitiveKeys = [
            'apikey', 'token', 'secret', 'password', 'auth', 'credentials', 'privatekey',
            ...this._options.customRedactKeys.map(k => k.toLowerCase())
        ];

        this._auditLog = [];
        this._startTime = performance.now();
        this._bootTime = new Date().toISOString();

        // Initialize internal performance observer for core execution tracking
        this._setupPerformanceObserver();
    }

    /**
     * Sets up a performance observer to monitor internal marks and measures.
     * @private
     */
    _setupPerformanceObserver() {
        this._executionMetrics = {
            totalExecutions: 0,
            successfulExecutions: 0,
            failedExecutions: 0,
            averageExecutionTimeMs: 0,
            executionTimes: [] // Rolling window of last 100 execution times
        };

        try {
            this._perfObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                for (const entry of entries) {
                    if (entry.name.startsWith('execution_')) {
                        this._recordExecutionMetric(entry.duration);
                    }
                }
            });
            this._perfObserver.observe({ entryTypes: ['measure'], buffered: true });
        } catch (error) {
            this.emit('error', new ControlPlaneError('Failed to initialize PerformanceObserver', 'PERF_OBSERVER_ERROR', { error: error.message }));
        }
    }

    /**
     * Records an execution duration metric.
     * @param {number} duration - The duration in milliseconds.
     * @private
     */
    _recordExecutionMetric(duration) {
        const metrics = this._executionMetrics;
        metrics.totalExecutions++;
        metrics.executionTimes.push(duration);
        
        // Maintain a rolling window of 100 items
        if (metrics.executionTimes.length > 100) {
            metrics.executionTimes.shift();
        }

        const sum = metrics.executionTimes.reduce((a, b) => a + b, 0);
        metrics.averageExecutionTimeMs = sum / metrics.executionTimes.length;
    }

    /**
     * Logs an audit entry for a control plane query.
     * 
     * @param {string} endpoint - The queried endpoint.
     * @param {Object} [metadata={}] - Additional query metadata.
     * @private
     */
    _audit(endpoint, metadata = {}) {
        if (!this._options.enableAuditLog) return;

        const entry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            endpoint,
            metadata
        };

        this._auditLog.push(entry);

        // Keep audit log bounded to prevent memory leaks (max 1000 entries)
        if (this._auditLog.length > 1000) {
            this._auditLog.shift();
        }

        this.emit('audit', entry);
    }

    /**
     * Retrieves the complete, sanitized, and immutable system state.
     * This represents the global state of the Git History LLM engine.
     * 
     * @returns {Object} A frozen, read-only snapshot of the system state.
     * @throws {ControlPlaneError} If the state cannot be retrieved or processed.
     */
    getSystemState() {
        this._audit('getSystemState');
        
        try {
            // Assuming the registry has a method to get raw state, or exposes it via a property
            const rawState = typeof this._registry.getState === 'function' 
                ? this._registry.getState() 
                : this._registry.state || {};

            const clonedState = safeClone(rawState);
            const sanitizedState = sanitizeState(clonedState, this._sensitiveKeys);
            
            // Add control plane metadata to the state snapshot
            const stateSnapshot = {
                _meta: {
                    snapshotTimestamp: new Date().toISOString(),
                    engineVersion: this._registry.version || 'unknown',
                    nodeEnv: process.env.NODE_ENV || 'development'
                },
                data: sanitizedState
            };

            return deepFreeze(stateSnapshot);
        } catch (error) {
            throw new ControlPlaneError(
                'Failed to retrieve system state.',
                'STATE_RETRIEVAL_FAILED',
                { originalError: error.message }
            );
        }
    }

    /**
     * Retrieves the most recent execution logs or pipeline runs.
     * 
     * @param {number} [n=10] - The number of recent executions to retrieve (max 100).
     * @returns {Array<Object>} A frozen array of the recent execution records.
     * @throws {ControlPlaneError} If the executions cannot be retrieved.
     */
    getRecentExecutions(n = 10) {
        const limit = Math.min(Math.max(1, parseInt(n, 10) || 10), 100);
        this._audit('getRecentExecutions', { limit });

        try {
            // Assuming registry maintains an execution history
            let history = [];
            if (typeof this._registry.getExecutionHistory === 'function') {
                history = this._registry.getExecutionHistory(limit);
            } else if (Array.isArray(this._registry.executionLog)) {
                history = this._registry.executionLog.slice(-limit);
            } else {
                // Fallback if no history is maintained natively by the registry
                history = [{ note: 'Execution history not natively supported by registered system.' }];
            }

            const clonedHistory = safeClone(history);
            const sanitizedHistory = sanitizeState(clonedHistory, this._sensitiveKeys);

            return deepFreeze(sanitizedHistory);
        } catch (error) {
            throw new ControlPlaneError(
                `Failed to retrieve recent ${limit} executions.`,
                'EXECUTION_RETRIEVAL_FAILED',
                { originalError: error.message }
            );
        }
    }

    /**
     * Retrieves the current operational mode and active feature flags.
     * Useful for determining if the system is in 'BEAST_MODE', 'SAFE_MODE', etc.,
     * and what capabilities are currently enabled.
     * 
     * @returns {Object} A frozen object containing mode and flags.
     */
    getActiveModeAndFlags() {
        this._audit('getActiveModeAndFlags');

        try {
            const mode = this._registry.activeMode || process.env.SYSTEM_MODE || 'STANDARD';
            
            // Retrieve flags from registry or environment variables
            const flags = typeof this._registry.getFeatureFlags === 'function'
                ? this._registry.getFeatureFlags()
                : this._registry.featureFlags || {};

            const result = {
                mode: mode.toUpperCase(),
                flags: safeClone(flags),
                isMaintenance: !!this._registry.isMaintenanceMode,
                isDegraded: !!this._registry.isDegraded
            };

            return deepFreeze(result);
        } catch (error) {
            throw new ControlPlaneError(
                'Failed to retrieve active mode and flags.',
                'MODE_RETRIEVAL_FAILED',
                { originalError: error.message }
            );
        }
    }

    /**
     * Aggregates and retrieves comprehensive performance metrics of the system.
     * Includes memory usage, CPU load, uptime, and internal execution metrics.
     * 
     * @returns {Object} A frozen object containing detailed performance metrics.
     */
    getPerformanceMetrics() {
        this._audit('getPerformanceMetrics');

        try {
            const memoryUsage = process.memoryUsage();
            const cpuUsage = process.cpuUsage();
            const uptimeSec = process.uptime();
            
            // Calculate heap usage percentage
            const heapUsagePercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

            const metrics = {
                system: {
                    bootTime: this._bootTime,
                    uptimeSeconds: parseFloat(uptimeSec.toFixed(2)),
                    platform: os.platform(),
                    arch: os.arch(),
                    cpus: os.cpus().length,
                    totalSystemMemoryMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(2)),
                    freeSystemMemoryMB: parseFloat((os.freemem() / 1024 / 1024).toFixed(2))
                },
                process: {
                    memory: {
                        rssMB: parseFloat((memoryUsage.rss / 1024 / 1024).toFixed(2)),
                        heapTotalMB: parseFloat((memoryUsage.heapTotal / 1024 / 1024).toFixed(2)),
                        heapUsedMB: parseFloat((memoryUsage.heapUsed / 1024 / 1024).toFixed(2)),
                        externalMB: parseFloat((memoryUsage.external / 1024 / 1024).toFixed(2)),
                        heapUsagePercent: parseFloat(heapUsagePercent.toFixed(2))
                    },
                    cpu: {
                        userMicroseconds: cpuUsage.user,
                        systemMicroseconds: cpuUsage.system
                    }
                },
                execution: {
                    totalTracked: this._executionMetrics.totalExecutions,
                    averageExecutionTimeMs: parseFloat(this._executionMetrics.averageExecutionTimeMs.toFixed(2)),
                    // Fetch registry-specific metrics if available
                    ...(typeof this._registry.getMetrics === 'function' ? this._registry.getMetrics() : {})
                },
                health: this._evaluateSystemHealth(heapUsagePercent)
            };

            return deepFreeze(metrics);
        } catch (error) {
            throw new ControlPlaneError(
                'Failed to aggregate performance metrics.',
                'METRICS_RETRIEVAL_FAILED',
                { originalError: error.message }
            );
        }
    }

    /**
     * Evaluates the overall health of the system based on current metrics.
     * 
     * @param {number} heapUsagePercent - The current heap usage percentage.
     * @returns {string} Status indicator: 'HEALTHY', 'WARNING', or 'CRITICAL'.
     * @private
     */
    _evaluateSystemHealth(heapUsagePercent) {
        if (heapUsagePercent > 90) return 'CRITICAL';
        if (heapUsagePercent > 75) return 'WARNING';
        
        if (this._registry.isDegraded) return 'WARNING';
        
        return 'HEALTHY';
    }

    /**
     * Retrieves the audit log of control plane queries.
     * Useful for governance and tracking who/what is introspecting the system.
     * 
     * @returns {Array<Object>} Frozen array of audit log entries.
     */
    getAuditLog() {
        return deepFreeze(safeClone(this._auditLog));
    }

    /**
     * Gracefully shuts down the control plane, releasing observers.
     */
    shutdown() {
        if (this._perfObserver) {
            this._perfObserver.disconnect();
        }
        this.emit('shutdown', { timestamp: new Date().toISOString() });
        this.removeAllListeners();
    }
}

module.exports = {
    ControlPlane,
    ControlPlaneError,
    deepFreeze,
    sanitizeState
};