/**
 * @fileoverview Stability Controller with Hysteresis and Cooldown.
 * 
 * This module provides a robust stabilization controller designed to prevent
 * oscillation (flapping) in adaptive systems, specifically tailored for the
 * Git History LLM pipeline. When dynamically adjusting parameters (e.g., LLM 
 * temperature, chunk sizes, or retry limits based on API degradation), this 
 * controller ensures that changes are only applied when a persistent trend is 
 * detected, and reverted only when stability is thoroughly proven.
 * 
 * Core Features:
 * - Hysteresis Control: Asymmetric thresholds for degradation vs. recovery.
 * - Cooldown Mechanisms: Prevents rapid state toggling.
 * - Event-Driven Architecture: Emits events for system-wide reactivity.
 * - Telemetry & Metrics: Tracks signal history and transition statistics.
 * 
 * @module core/stability
 * @requires node:events
 */

const { EventEmitter } = require('events');

/**
 * Enum for supported signal types.
 * @readonly
 * @enum {string}
 */
const SignalTypes = {
    DEGRADATION: 'DEGRADATION',
    STABLE: 'STABLE'
};

/**
 * Enum for controller states.
 * @readonly
 * @enum {string}
 */
const ControllerStates = {
    STABLE: 'STABLE',
    ADAPTED: 'ADAPTED'
};

/**
 * @typedef {Object} StabilityConfig
 * @property {number} [degradationThreshold=3] - Consecutive degradation signals required to trigger adaptation.
 * @property {number} [stableThreshold=5] - Consecutive stable signals required to revert adaptation.
 * @property {number} [cooldownMs=60000] - Minimum time (in milliseconds) between state transitions.
 * @property {number} [historyLimit=100] - Maximum number of signals to retain in telemetry history.
 * @property {Object} [logger=console] - Injected logger instance (must support info, warn, error, debug).
 */

/**
 * @typedef {Object} SignalPayload
 * @property {string} source - The component emitting the signal (e.g., 'LLM_PARSER', 'GIT_FETCHER').
 * @property {number} timestamp - Epoch timestamp of the signal.
 * @property {Object} [metadata] - Additional context regarding the signal.
 */

/**
 * StabilityController manages system state transitions based on incoming signals,
 * applying hysteresis and cooldown logic to guarantee stable adaptive behavior.
 * 
 * @class
 * @extends EventEmitter
 */
class StabilityController extends EventEmitter {
    /**
     * Initializes a new instance of the StabilityController.
     * 
     * @param {StabilityConfig} [config={}] - Configuration options for the controller.
     */
    constructor(config = {}) {
        super();

        // 1. Configuration Initialization with defaults and validation
        this.config = {
            degradationThreshold: this._validatePositiveInteger(config.degradationThreshold, 3, 'degradationThreshold'),
            stableThreshold: this._validatePositiveInteger(config.stableThreshold, 5, 'stableThreshold'),
            cooldownMs: this._validatePositiveInteger(config.cooldownMs, 60000, 'cooldownMs'),
            historyLimit: this._validatePositiveInteger(config.historyLimit, 100, 'historyLimit'),
            logger: config.logger || console
        };

        // 2. State Management
        /** @type {ControllerStates} */
        this.currentState = ControllerStates.STABLE;
        
        // 3. Counters
        this.consecutiveDegradations = 0;
        this.consecutiveStables = 0;
        
        // 4. Time Tracking
        this.lastTransitionTimestamp = 0;
        
        // 5. Telemetry & Metrics
        this.signalHistory = [];
        this.metrics = {
            totalSignalsReceived: 0,
            totalAdaptationsTriggered: 0,
            totalRevertsTriggered: 0,
            signalsDroppedDuringCooldown: 0
        };

        this.config.logger.info(`[StabilityController] Initialized with Degradation Threshold: ${this.config.degradationThreshold}, Stable Threshold: ${this.config.stableThreshold}, Cooldown: ${this.config.cooldownMs}ms`);
    }

    /**
     * Validates that a given value is a positive integer, falling back to a default if undefined.
     * 
     * @private
     * @param {any} value - The value to validate.
     * @param {number} defaultValue - The fallback value.
     * @param {string} paramName - The name of the parameter for error logging.
     * @returns {number} The validated positive integer.
     * @throws {TypeError} If the provided value is explicitly invalid (not undefined, but wrong type).
     */
    _validatePositiveInteger(value, defaultValue, paramName) {
        if (value === undefined) return defaultValue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throw new TypeError(`[StabilityController] Invalid configuration for '${paramName}': must be a positive integer.`);
        }
        return value;
    }

    /**
     * Records a new signal into the stability controller. This is the primary entry point
     * for external systems to report their health/status.
     * 
     * @param {SignalTypes} type - The type of signal ('DEGRADATION' or 'STABLE').
     * @param {SignalPayload} [payload={}] - Contextual information about the signal.
     * @returns {ControllerStates} The current state of the controller after processing the signal.
     */
    recordSignal(type, payload = {}) {
        const timestamp = Date.now();
        const enrichedPayload = { ...payload, timestamp, type };

        // Validate signal type
        if (!Object.values(SignalTypes).includes(type)) {
            this.config.logger.error(`[StabilityController] Unknown signal type received: ${type}`);
            throw new Error(`Invalid signal type: ${type}`);
        }

        this.metrics.totalSignalsReceived++;
        this._recordToHistory(enrichedPayload);

        // Check cooldown phase
        if (this.isCooldownActive(timestamp)) {
            this.metrics.signalsDroppedDuringCooldown++;
            this.config.logger.debug(`[StabilityController] Signal ignored due to active cooldown. Time remaining: ${this.getRemainingCooldown(timestamp)}ms`);
            
            // While in cooldown, we reset counters to ensure we don't immediately trigger 
            // a new transition the millisecond the cooldown expires based on stale signals.
            this._resetCounters();
            return this.currentState;
        }

        // Process Signal
        if (type === SignalTypes.DEGRADATION) {
            this._processDegradation(enrichedPayload);
        } else if (type === SignalTypes.STABLE) {
            this._processStable(enrichedPayload);
        }

        return this.currentState;
    }

    /**
     * Processes a degradation signal, incrementing the degradation counter and
     * evaluating if an adaptation transition is required.
     * 
     * @private
     * @param {SignalPayload} payload - The signal context.
     */
    _processDegradation(payload) {
        this.consecutiveDegradations++;
        this.consecutiveStables = 0; // Reset opposing counter immediately

        this.config.logger.debug(`[StabilityController] Degradation signal received. Consecutive: ${this.consecutiveDegradations}/${this.config.degradationThreshold}`);

        if (this.currentState === ControllerStates.STABLE && this.consecutiveDegradations >= this.config.degradationThreshold) {
            this._triggerAdaptation(payload);
        }
    }

    /**
     * Processes a stable signal, incrementing the stable counter and
     * evaluating if a revert transition is required.
     * 
     * @private
     * @param {SignalPayload} payload - The signal context.
     */
    _processStable(payload) {
        this.consecutiveStables++;
        this.consecutiveDegradations = 0; // Reset opposing counter immediately

        this.config.logger.debug(`[StabilityController] Stable signal received. Consecutive: ${this.consecutiveStables}/${this.config.stableThreshold}`);

        if (this.currentState === ControllerStates.ADAPTED && this.consecutiveStables >= this.config.stableThreshold) {
            this._revertAdaptation(payload);
        }
    }

    /**
     * Executes the transition from STABLE to ADAPTED state.
     * Emits the 'adaptationTriggered' event.
     * 
     * @private
     * @param {SignalPayload} payload - The payload that triggered the adaptation.
     */
    _triggerAdaptation(payload) {
        this.currentState = ControllerStates.ADAPTED;
        this.lastTransitionTimestamp = payload.timestamp;
        this.metrics.totalAdaptationsTriggered++;
        
        this._resetCounters();

        this.config.logger.warn(`[StabilityController] State transitioned to ADAPTED. Hysteresis threshold (${this.config.degradationThreshold}) met.`, payload);
        
        this.emit('adaptationTriggered', {
            state: this.currentState,
            timestamp: this.lastTransitionTimestamp,
            triggerPayload: payload,
            metrics: this.getMetrics()
        });
    }

    /**
     * Executes the transition from ADAPTED to STABLE state.
     * Emits the 'adaptationReverted' event.
     * 
     * @private
     * @param {SignalPayload} payload - The payload that triggered the revert.
     */
    _revertAdaptation(payload) {
        this.currentState = ControllerStates.STABLE;
        this.lastTransitionTimestamp = payload.timestamp;
        this.metrics.totalRevertsTriggered++;
        
        this._resetCounters();

        this.config.logger.info(`[StabilityController] State transitioned to STABLE. Hysteresis threshold (${this.config.stableThreshold}) met.`, payload);
        
        this.emit('adaptationReverted', {
            state: this.currentState,
            timestamp: this.lastTransitionTimestamp,
            triggerPayload: payload,
            metrics: this.getMetrics()
        });
    }

    /**
     * Determines if the controller is currently in a cooldown period.
     * 
     * @param {number} [currentTimestamp=Date.now()] - The current epoch timestamp.
     * @returns {boolean} True if cooldown is active, false otherwise.
     */
    isCooldownActive(currentTimestamp = Date.now()) {
        if (this.lastTransitionTimestamp === 0) return false;
        return (currentTimestamp - this.lastTransitionTimestamp) < this.config.cooldownMs;
    }

    /**
     * Calculates the remaining time in the current cooldown period.
     * 
     * @param {number} [currentTimestamp=Date.now()] - The current epoch timestamp.
     * @returns {number} Milliseconds remaining in cooldown, or 0 if not in cooldown.
     */
    getRemainingCooldown(currentTimestamp = Date.now()) {
        if (!this.isCooldownActive(currentTimestamp)) return 0;
        return this.config.cooldownMs - (currentTimestamp - this.lastTransitionTimestamp);
    }

    /**
     * Resets internal tracking counters.
     * 
     * @private
     */
    _resetCounters() {
        this.consecutiveDegradations = 0;
        this.consecutiveStables = 0;
    }

    /**
     * Maintains the telemetry history array within the configured limits.
     * 
     * @private
     * @param {SignalPayload} payload - The enriched signal payload to store.
     */
    _recordToHistory(payload) {
        this.signalHistory.push(payload);
        if (this.signalHistory.length > this.config.historyLimit) {
            this.signalHistory.shift(); // Remove oldest signal
        }
    }

    /**
     * Retrieves the current state of the controller.
     * 
     * @returns {ControllerStates} Current state.
     */
    getState() {
        return this.currentState;
    }

    /**
     * Retrieves internal metrics and current counter values for observability.
     * 
     * @returns {Object} A snapshot of current metrics and counters.
     */
    getMetrics() {
        return {
            ...this.metrics,
            currentState: this.currentState,
            consecutiveDegradations: this.consecutiveDegradations,
            consecutiveStables: this.consecutiveStables,
            isCooldownActive: this.isCooldownActive(),
            remainingCooldownMs: this.getRemainingCooldown(),
            historySize: this.signalHistory.length
        };
    }

    /**
     * Retrieves the signal history telemetry.
     * 
     * @returns {Array<SignalPayload>} Array of recent signals.
     */
    getHistory() {
        return [...this.signalHistory];
    }

    /**
     * Forcefully overrides the current state and resets counters.
     * Use with caution, primarily for administrative interventions or severe error recovery.
     * 
     * @param {ControllerStates} newState - The state to force.
     * @param {string} reason - Justification for the forced override.
     */
    forceState(newState, reason) {
        if (!Object.values(ControllerStates).includes(newState)) {
            throw new Error(`[StabilityController] Invalid state for force override: ${newState}`);
        }

        const previousState = this.currentState;
        this.currentState = newState;
        this.lastTransitionTimestamp = Date.now(); // Triggers a new cooldown
        this._resetCounters();

        this.config.logger.warn(`[StabilityController] State forcefully overridden from ${previousState} to ${newState}. Reason: ${reason}`);
        
        this.emit('stateForced', {
            previousState,
            newState,
            reason,
            timestamp: this.lastTransitionTimestamp
        });
    }

    /**
     * Hard resets the controller to its factory initial state.
     * Clears all metrics, history, and active cooldowns.
     */
    reset() {
        this.currentState = ControllerStates.STABLE;
        this.consecutiveDegradations = 0;
        this.consecutiveStables = 0;
        this.lastTransitionTimestamp = 0;
        this.signalHistory = [];
        this.metrics = {
            totalSignalsReceived: 0,
            totalAdaptationsTriggered: 0,
            totalRevertsTriggered: 0,
            signalsDroppedDuringCooldown: 0
        };
        this.config.logger.info('[StabilityController] Controller has been hard reset.');
        this.emit('reset', { timestamp: Date.now() });
    }
}

module.exports = {
    StabilityController,
    SignalTypes,
    ControllerStates
};