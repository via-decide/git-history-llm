/**
 * @fileoverview Adaptive Control System for Git History LLM.
 * 
 * This module implements a robust, self-correcting adaptive controller designed to
 * dynamically adjust execution parameters (concurrency, batch sizes, timeouts, retries)
 * based on real-time performance feedback. It utilizes a combination of Additive Increase
 * Multiplicative Decrease (AIMD), Proportional-Integral-Derivative (PID) control, and
 * Circuit Breaker patterns to prevent sustained degradation when interfacing with 
 * external LLM APIs and local git processing pipelines.
 * 
 * @module core/adaptive
 * @version 1.0.0
 * @license MIT
 */

'use strict';

const EventEmitter = require('events');

/**
 * @typedef {Object} PerformanceFeedback
 * @property {number} score - Overall performance score (0.0 to 1.0), 1.0 being optimal.
 * @property {number} latencyMs - Average latency of the last execution batch.
 * @property {number} errorRate - Ratio of failed requests to total requests (0.0 to 1.0).
 * @property {number} tokenUsage - Number of LLM tokens consumed in the last window.
 * @property {number} rateLimitRemaining - Estimated remaining API calls in the current window.
 * @property {Array<string>} [specificErrors] - Array of error codes/types encountered (e.g., 'TIMEOUT', 'RATE_LIMIT').
 */

/**
 * @typedef {Object} ExecutionParameters
 * @property {number} concurrency - Maximum number of parallel tasks.
 * @property {number} batchSize - Number of commits/diffs to process in a single LLM prompt.
 * @property {number} timeoutMs - Maximum time allowed for an operation before aborting.
 * @property {number} maxRetries - Maximum number of retry attempts for transient failures.
 * @property {number} backoffMultiplier - Multiplier for exponential backoff on retries.
 */

/**
 * @typedef {Object} AdaptiveConfig
 * @property {number} [windowSize=50] - Number of historical data points to retain for trend analysis.
 * @property {number} [targetScore=0.95] - The ideal performance score the system strives to maintain.
 * @property {number} [degradationThreshold=0.7] - Score below which the system is considered degraded.
 * @property {number} [criticalThreshold=0.4] - Score below which the circuit breaker may trip.
 * @property {ExecutionParameters} [minParams] - Absolute minimum bounds for execution parameters.
 * @property {ExecutionParameters} [maxParams] - Absolute maximum bounds for execution parameters.
 */

// ============================================================================
// Constants & Enums
// ============================================================================

/**
 * Represents the current operational state of the Adaptive System.
 * @enum {string}
 */
const SYSTEM_STATES = {
    OPTIMAL: 'OPTIMAL',         // System is performing well, parameters can be scaled up.
    STABLE: 'STABLE',           // System is performing adequately, maintain current parameters.
    DEGRADED: 'DEGRADED',       // Performance drop detected, parameters must be scaled down.
    CRITICAL: 'CRITICAL',       // Severe degradation, drastic reduction or circuit breaking required.
    RECOVERY: 'RECOVERY'        // System is recovering from a critical state, scale up cautiously.
};

/**
 * States for the internal Circuit Breaker.
 * @enum {string}
 */
const BREAKER_STATES = {
    CLOSED: 'CLOSED',           // Normal operation, requests flow freely.
    OPEN: 'OPEN',               // Failing consistently, requests are blocked.
    HALF_OPEN: 'HALF_OPEN'      // Testing recovery, allowing limited requests.
};

// ============================================================================
// Utility Classes
// ============================================================================

/**
 * A highly efficient fixed-size circular buffer for storing time-series metrics
 * without triggering constant array reallocation and garbage collection.
 */
class RingBuffer {
    /**
     * @param {number} capacity - Maximum number of items the buffer can hold.
     */
    constructor(capacity) {
        if (capacity <= 0) throw new Error('RingBuffer capacity must be > 0');
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
    }

    /**
     * Adds a new item to the buffer, overwriting the oldest item if full.
     * @param {*} item 
     */
    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        } else {
            this.tail = (this.tail + 1) % this.capacity;
        }
    }

    /**
     * Retrieves all items currently in the buffer in chronological order.
     * @returns {Array<*>}
     */
    toArray() {
        const result = [];
        let current = this.tail;
        for (let i = 0; i < this.size; i++) {
            result.push(this.buffer[current]);
            current = (current + 1) % this.capacity;
        }
        return result;
    }

    /**
     * Clears the buffer.
     */
    clear() {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
    }

    /**
     * Returns the most recently added item.
     * @returns {*}
     */
    peekLast() {
        if (this.size === 0) return null;
        const index = this.head === 0 ? this.capacity - 1 : this.head - 1;
        return this.buffer[index];
    }
}

/**
 * Proportional-Integral-Derivative (PID) Controller.
 * Used to smoothly adjust continuous variables (like concurrency) towards a target setpoint.
 */
class PIDController {
    constructor(kp, ki, kd) {
        this.kp = kp; // Proportional gain
        this.ki = ki; // Integral gain
        this.kd = kd; // Derivative gain
        
        this.integral = 0;
        this.previousError = 0;
        this.lastTime = Date.now();
    }

    /**
     * Calculates the control variable adjustment based on the current error.
     * @param {number} setpoint - The desired target value.
     * @param {number} measuredValue - The current actual value.
     * @returns {number} The calculated adjustment.
     */
    update(setpoint, measuredValue) {
        const now = Date.now();
        const dt = (now - this.lastTime) / 1000 || 0.001; // Avoid divide by zero, default to 1ms
        
        const error = setpoint - measuredValue;
        
        // Proportional term
        const pOut = this.kp * error;
        
        // Integral term (with anti-windup clamping)
        this.integral += error * dt;
        // Clamp integral to prevent massive oscillations
        this.integral = Math.max(Math.min(this.integral, 10), -10); 
        const iOut = this.ki * this.integral;
        
        // Derivative term
        const derivative = (error - this.previousError) / dt;
        const dOut = this.kd * derivative;
        
        // Update state
        this.previousError = error;
        this.lastTime = now;
        
        return pOut + iOut + dOut;
    }

    reset() {
        this.integral = 0;
        this.previousError = 0;
        this.lastTime = Date.now();
    }
}

/**
 * Circuit Breaker implementation to completely halt execution if external
 * dependencies (like the LLM API) are failing catastrophically.
 */
class CircuitBreaker extends EventEmitter {
    constructor(failureThreshold = 5, resetTimeoutMs = 30000) {
        super();
        this.state = BREAKER_STATES.CLOSED;
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
        this.failureCount = 0;
        this.resetTimer = null;
    }

    recordSuccess() {
        if (this.state === BREAKER_STATES.HALF_OPEN) {
            this.reset();
        } else {
            this.failureCount = 0;
        }
    }

    recordFailure() {
        this.failureCount++;
        if (this.state === BREAKER_STATES.CLOSED && this.failureCount >= this.failureThreshold) {
            this.trip();
        }
    }

    trip() {
        this.state = BREAKER_STATES.OPEN;
        this.emit('trip');
        
        if (this.resetTimer) clearTimeout(this.resetTimer);
        
        this.resetTimer = setTimeout(() => {
            this.state = BREAKER_STATES.HALF_OPEN;
            this.emit('halfOpen');
        }, this.resetTimeoutMs);
    }

    reset() {
        this.state = BREAKER_STATES.CLOSED;
        this.failureCount = 0;
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.emit('reset');
    }

    isOpen() {
        return this.state === BREAKER_STATES.OPEN;
    }
}

// ============================================================================
// Main Adaptive Controller
// ============================================================================

/**
 * The core Adaptive Controller for Git History LLM.
 * Orchestrates parameter tuning based on ingested performance metrics.
 * 
 * @fires AdaptiveController#stateChange
 * @fires AdaptiveController#parametersUpdated
 * @fires AdaptiveController#circuitBreakerTripped
 */
class AdaptiveController extends EventEmitter {
    /**
     * @param {AdaptiveConfig} config - Configuration overrides.
     */
    constructor(config = {}) {
        super();
        
        // Configuration initialization with defaults
        this.config = {
            windowSize: config.windowSize || 50,
            targetScore: config.targetScore || 0.95,
            degradationThreshold: config.degradationThreshold || 0.75,
            criticalThreshold: config.criticalThreshold || 0.50,
            minParams: Object.assign({
                concurrency: 1,
                batchSize: 1,
                timeoutMs: 5000,
                maxRetries: 1,
                backoffMultiplier: 1.5
            }, config.minParams || {}),
            maxParams: Object.assign({
                concurrency: 20,
                batchSize: 50,
                timeoutMs: 120000,
                maxRetries: 5,
                backoffMultiplier: 3.0
            }, config.maxParams || {})
        };

        // Current operational state
        this.currentState = SYSTEM_STATES.OPTIMAL;
        
        // Active parameters initialized to safe middle-ground
        this.currentParams = {
            concurrency: Math.floor((this.config.maxParams.concurrency + this.config.minParams.concurrency) / 2),
            batchSize: Math.floor((this.config.maxParams.batchSize + this.config.minParams.batchSize) / 2),
            timeoutMs: 30000,
            maxRetries: 3,
            backoffMultiplier: 2.0
        };

        // Sub-systems
        this.metricsHistory = new RingBuffer(this.config.windowSize);
        this.circuitBreaker = new CircuitBreaker(5, 60000); // 5 critical failures, 60s cooldown
        
        // PID Controllers for continuous tuning
        // Tuned for slow, stable adjustments to avoid wild swings
        this.concurrencyPid = new PIDController(0.5, 0.1, 0.05); 
        this.batchSizePid = new PIDController(0.4, 0.05, 0.02);

        // Bind circuit breaker events
        this.circuitBreaker.on('trip', () => {
            this._transitionState(SYSTEM_STATES.CRITICAL);
            this.emit('circuitBreakerTripped');
            this._applyFailsafeParameters();
        });

        this.circuitBreaker.on('halfOpen', () => {
            this._transitionState(SYSTEM_STATES.RECOVERY);
        });

        this.circuitBreaker.on('reset', () => {
            this._transitionState(SYSTEM_STATES.STABLE);
        });
    }

    /**
     * Ingests a new performance feedback reading from the execution engine.
     * This is the primary entry point for the feedback loop.
     * 
     * @param {PerformanceFeedback} feedback 
     */
    recordFeedback(feedback) {
        this._validateFeedback(feedback);
        this.metricsHistory.push(feedback);

        // Immediate circuit breaker evaluation based on error rate
        if (feedback.errorRate > 0.8 || (feedback.specificErrors && feedback.specificErrors.includes('AUTH_FAILED'))) {
            this.circuitBreaker.recordFailure();
        } else if (feedback.errorRate === 0) {
            this.circuitBreaker.recordSuccess();
        }

        // If circuit breaker is open, we do not tune parameters, we just wait.
        if (this.circuitBreaker.isOpen()) {
            return;
        }

        this._evaluateSystemState();
        this._tuneParameters();
    }

    /**
     * Returns the currently optimized execution parameters.
     * The execution engine should call this before dispatching new work.
     * 
     * @returns {ExecutionParameters}
     */
    getCurrentParameters() {
        // If the circuit breaker is open, return absolute minimums to prevent load
        if (this.circuitBreaker.isOpen()) {
            return { ...this.config.minParams };
        }
        return { ...this.currentParams };
    }

    /**
     * Returns the current state of the adaptive system.
     * @returns {string}
     */
    getSystemState() {
        return this.currentState;
    }

    /**
     * Manually forces the system into a specific state (useful for administrative override).
     * @param {string} state - One of SYSTEM_STATES
     */
    forceState(state) {
        if (!Object.values(SYSTEM_STATES).includes(state)) {
            throw new Error(`Invalid state: ${state}`);
        }
        this._transitionState(state);
    }

    // ============================================================================
    // Internal Private Methods
    // ============================================================================

    /**
     * Validates incoming feedback object to ensure required fields exist.
     * @private
     * @param {PerformanceFeedback} feedback 
     */
    _validateFeedback(feedback) {
        if (typeof feedback.score !== 'number' || feedback.score < 0 || feedback.score > 1) {
            throw new Error('Feedback score must be a number between 0.0 and 1.0');
        }
        if (typeof feedback.latencyMs !== 'number' || feedback.latencyMs < 0) {
            feedback.latencyMs = 0; // Default fallback
        }
        if (typeof feedback.errorRate !== 'number' || feedback.errorRate < 0 || feedback.errorRate > 1) {
            feedback.errorRate = 0; // Default fallback
        }
    }

    /**
     * Analyzes the recent metrics history to determine the overall system health state.
     * @private
     */
    _evaluateSystemState() {
        const history = this.metricsHistory.toArray();
        if (history.length < 5) return; // Not enough data to change state yet

        // Calculate moving averages over the last N records
        const recentHistory = history.slice(-5);
        const avgScore = recentHistory.reduce((sum, f) => sum + f.score, 0) / recentHistory.length;
        const avgErrorRate = recentHistory.reduce((sum, f) => sum + f.errorRate, 0) / recentHistory.length;

        let newState = this.currentState;

        if (avgErrorRate > 0.5 || avgScore < this.config.criticalThreshold) {
            newState = SYSTEM_STATES.CRITICAL;
        } else if (avgScore < this.config.degradationThreshold || avgErrorRate > 0.1) {
            newState = SYSTEM_STATES.DEGRADED;
        } else if (avgScore >= this.config.targetScore) {
            // Only move to optimal if we aren't recovering
            if (this.currentState !== SYSTEM_STATES.RECOVERY || history.length > 10) {
                newState = SYSTEM_STATES.OPTIMAL;
            }
        } else {
            newState = SYSTEM_STATES.STABLE;
        }

        // Specific trigger overrides
        const lastFeedback = this.metricsHistory.peekLast();
        if (lastFeedback && lastFeedback.specificErrors) {
            if (lastFeedback.specificErrors.includes('RATE_LIMIT_EXCEEDED')) {
                newState = SYSTEM_STATES.DEGRADED; // Force degraded on rate limits
            }
        }

        if (newState !== this.currentState) {
            this._transitionState(newState);
        }
    }

    /**
     * Handles state transitions, resetting PID controllers if necessary,
     * and emitting events for external listeners.
     * @private
     * @param {string} newState 
     */
    _transitionState(newState) {
        const oldState = this.currentState;
        this.currentState = newState;
        
        // Reset PID integrals on major state shifts to prevent windup carrying over
        if (newState === SYSTEM_STATES.CRITICAL || newState === SYSTEM_STATES.RECOVERY) {
            this.concurrencyPid.reset();
            this.batchSizePid.reset();
        }

        this.emit('stateChange', { oldState, newState, timestamp: Date.now() });
    }

    /**
     * Core tuning algorithm. Adjusts parameters based on current state and PID outputs.
     * @private
     */
    _tuneParameters() {
        const lastFeedback = this.metricsHistory.peekLast();
        if (!lastFeedback) return;

        const oldParams = { ...this.currentParams };

        switch (this.currentState) {
            case SYSTEM_STATES.OPTIMAL:
                this._applyAIMD(true); // Additive Increase
                this._tuneViaPID(lastFeedback.score);
                // Reduce timeouts and retries as system is healthy
                this.currentParams.timeoutMs = Math.max(this.config.minParams.timeoutMs, this.currentParams.timeoutMs * 0.95);
                this.currentParams.maxRetries = this.config.minParams.maxRetries;
                break;

            case SYSTEM_STATES.STABLE:
                // Minor PID adjustments only
                this._tuneViaPID(lastFeedback.score);
                break;

            case SYSTEM_STATES.DEGRADED:
                this._applyAIMD(false); // Multiplicative Decrease
                // Increase timeouts and retries to handle degradation gracefully
                this.currentParams.timeoutMs = Math.min(this.config.maxParams.timeoutMs, this.currentParams.timeoutMs * 1.2);
                this.currentParams.maxRetries = Math.min(this.config.maxParams.maxRetries, this.currentParams.maxRetries + 1);
                this.currentParams.backoffMultiplier = Math.min(this.config.maxParams.backoffMultiplier, this.currentParams.backoffMultiplier * 1.1);
                
                // Specific LLM API handling
                if (lastFeedback.specificErrors && lastFeedback.specificErrors.includes('RATE_LIMIT_EXCEEDED')) {
                    // Drastic batch size reduction on rate limits
                    this.currentParams.batchSize = Math.max(this.config.minParams.batchSize, Math.floor(this.currentParams.batchSize * 0.5));
                }
                break;

            case SYSTEM_STATES.CRITICAL:
                this._applyFailsafeParameters();
                break;

            case SYSTEM_STATES.RECOVERY:
                // Very slow additive increase
                if (Math.random() > 0.5) { // Slow down the increase rate artificially
                    this.currentParams.concurrency = Math.min(this.config.maxParams.concurrency, this.currentParams.concurrency + 1);
                }
                this.currentParams.timeoutMs = this.config.maxParams.timeoutMs; // Keep timeouts high during recovery
                break;
        }

        this._clampParameters();

        // Emit if parameters actually changed
        if (JSON.stringify(oldParams) !== JSON.stringify(this.currentParams)) {
            this.emit('parametersUpdated', {
                oldParameters: oldParams,
                newParameters: this.currentParams,
                state: this.currentState
            });
        }
    }

    /**
     * Applies Additive Increase / Multiplicative Decrease logic.
     * Standard algorithm for network congestion avoidance, highly applicable to API rate limits.
     * @private
     * @param {boolean} increase - True to additively increase, False to multiplicatively decrease.
     */
    _applyAIMD(increase) {
        if (increase) {
            // Additive Increase (+1)
            this.currentParams.concurrency += 1;
            this.currentParams.batchSize += 1;
        } else {
            // Multiplicative Decrease (halve it)
            this.currentParams.concurrency = Math.floor(this.currentParams.concurrency * 0.5);
            this.currentParams.batchSize = Math.floor(this.currentParams.batchSize * 0.75); // Slightly less aggressive on batch size
        }
    }

    /**
     * Applies PID control for fine-tuning continuous parameters.
     * @private
     * @param {number} currentScore 
     */
    _tuneViaPID(currentScore) {
        // We want the score to match targetScore
        const concurrencyAdjustment = this.concurrencyPid.update(this.config.targetScore, currentScore);
        const batchSizeAdjustment = this.batchSizePid.update(this.config.targetScore, currentScore);

        // Apply adjustments (rounded, as these parameters must be integers)
        this.currentParams.concurrency += Math.round(concurrencyAdjustment);
        this.currentParams.batchSize += Math.round(batchSizeAdjustment);
    }

    /**
     * Drops all parameters to their absolute minimums. Used in critical states.
     * @private
     */
    _applyFailsafeParameters() {
        this.currentParams.concurrency = this.config.minParams.concurrency;
        this.currentParams.batchSize = this.config.minParams.batchSize;
        // Maximize resilience parameters
        this.currentParams.timeoutMs = this.config.maxParams.timeoutMs;
        this.currentParams.maxRetries = this.config.maxParams.maxRetries;
        this.currentParams.backoffMultiplier = this.config.maxParams.backoffMultiplier;
    }

    /**
     * Ensures all current parameters strictly adhere to configured min/max boundaries.
     * @private
     */
    _clampParameters() {
        for (const key of Object.keys(this.currentParams)) {
            if (this.currentParams[key] < this.config.minParams[key]) {
                this.currentParams[key] = this.config.minParams[key];
            } else if (this.currentParams[key] > this.config.maxParams[key]) {
                this.currentParams[key] = this.config.maxParams[key];
            }
        }
        
        // Ensure integer constraints where necessary
        this.currentParams.concurrency = Math.floor(this.currentParams.concurrency);
        this.currentParams.batchSize = Math.floor(this.currentParams.batchSize);
        this.currentParams.maxRetries = Math.floor(this.currentParams.maxRetries);
    }
}

module.exports = {
    AdaptiveController,
    SYSTEM_STATES,
    BREAKER_STATES,
    RingBuffer,
    PIDController,
    CircuitBreaker
};