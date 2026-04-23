/**
 * @fileoverview Execution Modes and Feature Flag System for Git History LLM.
 * 
 * This module provides a robust, production-grade feature flag and execution mode
 * management system. It enables safe rollouts of new LLM reasoning capabilities,
 * prevents system-wide failures during experimental changes, and allows deterministic
 * execution contexts (e.g., Dry Run, Beast Mode, Production).
 * 
 * Capabilities:
 * - Environment-aware execution modes.
 * - Dynamic feature flag evaluation with support for complex rollout strategies.
 * - Deterministic percentage-based rollouts using context hashing (e.g., by commit SHA).
 * - Safe execution wrappers (fallback mechanisms) to prevent pipeline failures.
 * - Event-driven telemetry for monitoring feature usage and fallback triggers.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// ============================================================================
// Constants & Enums
// ============================================================================

/**
 * Standard execution modes available within the Git History LLM pipeline.
 * @enum {string}
 */
const EXECUTION_MODES = {
    PRODUCTION: 'production',
    DEVELOPMENT: 'development',
    STAGING: 'staging',
    DRY_RUN: 'dry_run',
    BEAST_MODE: 'beast_mode',
    TEST: 'test'
};

/**
 * Supported rollout strategies for feature flags.
 * @enum {string}
 */
const ROLLOUT_STRATEGIES = {
    BOOLEAN: 'boolean',           // Strictly true/false
    PERCENTAGE: 'percentage',     // Random percentage (0-100)
    DETERMINISTIC: 'deterministic'// Hash-based percentage using a context key (e.g., commit hash)
};

// ============================================================================
// Core Classes
// ============================================================================

/**
 * Represents a single Feature Flag and its evaluation logic.
 */
class FeatureFlag {
    /**
     * @param {string} name - Unique identifier for the feature flag.
     * @param {Object} options - Configuration options.
     * @param {string} [options.description] - Human-readable description of the flag.
     * @param {boolean} [options.defaultValue=false] - Default state if no strategy matches.
     * @param {string} [options.strategy=ROLLOUT_STRATEGIES.BOOLEAN] - The rollout strategy to use.
     * @param {number} [options.rolloutPercentage=0] - Percentage (0-100) for rollout strategies.
     * @param {string[]} [options.allowedModes=[]] - Specific modes where this flag is forced true.
     */
    constructor(name, options = {}) {
        if (!name || typeof name !== 'string') {
            throw new TypeError('FeatureFlag requires a valid string name.');
        }

        this.name = name;
        this.description = options.description || 'No description provided.';
        this.defaultValue = typeof options.defaultValue === 'boolean' ? options.defaultValue : false;
        this.strategy = Object.values(ROLLOUT_STRATEGIES).includes(options.strategy) 
            ? options.strategy 
            : ROLLOUT_STRATEGIES.BOOLEAN;
        this.rolloutPercentage = typeof options.rolloutPercentage === 'number' 
            ? Math.max(0, Math.min(100, options.rolloutPercentage)) 
            : 0;
        this.allowedModes = Array.isArray(options.allowedModes) ? options.allowedModes : [];
        
        // Allow environment variable overrides (e.g., FF_ENABLE_NEW_GRAPH=true)
        this.envOverrideKey = `FF_${this.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    }

    /**
     * Evaluates whether the feature flag is enabled for a given context.
     * 
     * @param {Object} context - Contextual data for evaluation.
     * @param {string} context.mode - The current system execution mode.
     * @param {string} [context.hashKey] - Key used for deterministic rollouts (e.g., a commit SHA).
     * @returns {boolean} True if the feature is enabled, false otherwise.
     */
    isEnabled(context = {}) {
        // 1. Check Environment Variable Overrides (Highest Priority)
        const envOverride = process.env[this.envOverrideKey];
        if (envOverride !== undefined) {
            return envOverride.toLowerCase() === 'true' || envOverride === '1';
        }

        // 2. Check Mode-based Overrides
        if (context.mode && this.allowedModes.includes(context.mode)) {
            return true;
        }

        // 3. Evaluate based on configured strategy
        switch (this.strategy) {
            case ROLLOUT_STRATEGIES.BOOLEAN:
                return this.defaultValue;

            case ROLLOUT_STRATEGIES.PERCENTAGE:
                if (this.rolloutPercentage === 0) return false;
                if (this.rolloutPercentage === 100) return true;
                return (Math.random() * 100) < this.rolloutPercentage;

            case ROLLOUT_STRATEGIES.DETERMINISTIC:
                if (this.rolloutPercentage === 0) return false;
                if (this.rolloutPercentage === 100) return true;
                if (!context.hashKey) {
                    console.warn(`[FeatureFlag] Deterministic strategy for '${this.name}' requires 'context.hashKey'. Falling back to default.`);
                    return this.defaultValue;
                }
                return this._calculateDeterministicRollout(context.hashKey);

            default:
                return this.defaultValue;
        }
    }

    /**
     * Calculates a deterministic boolean based on a hash key and the rollout percentage.
     * Useful for ensuring the same repository or commit always gets the same feature treatment.
     * 
     * @private
     * @param {string} key - The context key to hash.
     * @returns {boolean}
     */
    _calculateDeterministicRollout(key) {
        const hash = crypto.createHash('sha256').update(`${this.name}:${key}`).digest('hex');
        // Take the first 8 characters of the hash, convert to integer, modulo 100
        const hashInt = parseInt(hash.substring(0, 8), 16);
        const normalizedValue = hashInt % 100;
        return normalizedValue < this.rolloutPercentage;
    }
}

/**
 * Orchestrates Execution Modes, Feature Flags, and Safe Executions.
 * Emits events for telemetry and observability.
 */
class ModeOrchestrator extends EventEmitter {
    constructor() {
        super();
        this._currentMode = this._determineInitialMode();
        this._flags = new Map();
        
        // Automatically load any flags defined purely in environment variables
        this._loadEnvFlags();
    }

    // ========================================================================
    // Execution Mode Management
    // ========================================================================

    /**
     * Determines the initial execution mode based on environment variables.
     * @private
     * @returns {string}
     */
    _determineInitialMode() {
        const envMode = process.env.GIT_LLM_MODE || process.env.NODE_ENV;
        if (!envMode) return EXECUTION_MODES.PRODUCTION;

        const normalizedMode = envMode.toLowerCase();
        const matchedMode = Object.values(EXECUTION_MODES).find(m => m === normalizedMode);
        
        return matchedMode || EXECUTION_MODES.PRODUCTION;
    }

    /**
     * Gets the current execution mode.
     * @returns {string}
     */
    get mode() {
        return this._currentMode;
    }

    /**
     * Sets a new execution mode.
     * @param {string} newMode - The mode to transition to.
     * @throws {Error} If the mode is invalid.
     */
    setMode(newMode) {
        const normalizedMode = newMode.toLowerCase();
        if (!Object.values(EXECUTION_MODES).includes(normalizedMode)) {
            throw new Error(`Invalid execution mode: ${newMode}. Allowed modes: ${Object.values(EXECUTION_MODES).join(', ')}`);
        }
        
        const previousMode = this._currentMode;
        this._currentMode = normalizedMode;
        
        this.emit('modeChanged', { previousMode, newMode: this._currentMode });
    }

    /** Helper checks for common modes */
    isProduction() { return this._currentMode === EXECUTION_MODES.PRODUCTION; }
    isDevelopment() { return this._currentMode === EXECUTION_MODES.DEVELOPMENT; }
    isDryRun() { return this._currentMode === EXECUTION_MODES.DRY_RUN; }
    isBeastMode() { return this._currentMode === EXECUTION_MODES.BEAST_MODE; }

    // ========================================================================
    // Feature Flag Management
    // ========================================================================

    /**
     * Registers a new feature flag into the system.
     * 
     * @param {string} name - The feature flag identifier.
     * @param {Object} options - Configuration for the flag.
     * @returns {ModeOrchestrator} this instance for chaining.
     */
    registerFlag(name, options = {}) {
        if (this._flags.has(name)) {
            console.warn(`[ModeOrchestrator] Overwriting existing feature flag: ${name}`);
        }
        const flag = new FeatureFlag(name, options);
        this._flags.set(name, flag);
        this.emit('flagRegistered', { name, strategy: flag.strategy });
        return this;
    }

    /**
     * Evaluates if a feature is enabled.
     * 
     * @param {string} flagName - The name of the feature flag.
     * @param {Object} [context={}] - Additional context (e.g., hashKey for deterministic rollouts).
     * @returns {boolean}
     */
    isFeatureEnabled(flagName, context = {}) {
        // Beast Mode overrides all flags to TRUE unless explicitly protected
        if (this.isBeastMode() && !context.strictEvaluation) {
            return true;
        }

        const flag = this._flags.get(flagName);
        
        // If flag isn't registered, check if an environment variable exists anyway
        if (!flag) {
            const envKey = `FF_${flagName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
            if (process.env[envKey] !== undefined) {
                return process.env[envKey].toLowerCase() === 'true' || process.env[envKey] === '1';
            }
            return false;
        }

        const evaluationContext = {
            mode: this._currentMode,
            ...context
        };

        const result = flag.isEnabled(evaluationContext);
        
        this.emit('flagEvaluated', { flagName, result, context: evaluationContext });
        return result;
    }

    /**
     * Discovers and loads feature flags implicitly defined via environment variables.
     * @private
     */
    _loadEnvFlags() {
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('FF_')) {
                const flagName = key.substring(3).toLowerCase();
                if (!this._flags.has(flagName)) {
                    this.registerFlag(flagName, {
                        description: 'Auto-loaded from environment variable',
                        defaultValue: process.env[key].toLowerCase() === 'true' || process.env[key] === '1',
                        strategy: ROLLOUT_STRATEGIES.BOOLEAN
                    });
                }
            }
        });
    }

    // ========================================================================
    // Safe Execution & Fallback Mechanisms
    // ========================================================================

    /**
     * Safely executes an experimental feature with an automatic fallback mechanism.
     * This prevents system-wide failures during new feature rollouts.
     * 
     * @async
     * @param {string} flagName - The feature flag controlling the experimental code.
     * @param {Function} experimentalFn - The new/experimental function to run if flag is enabled.
     * @param {Function} fallbackFn - The stable/legacy function to run if flag is disabled or if experimentalFn fails.
     * @param {Object} [context={}] - Context for feature flag evaluation.
     * @returns {Promise<any>} The result of either the experimental or fallback function.
     */
    async executeSafely(flagName, experimentalFn, fallbackFn, context = {}) {
        const isEnabled = this.isFeatureEnabled(flagName, context);

        if (isEnabled) {
            try {
                const startTime = Date.now();
                const result = await experimentalFn();
                const duration = Date.now() - startTime;
                
                this.emit('executionSuccess', { flagName, type: 'experimental', duration });
                return result;
            } catch (error) {
                this.emit('executionError', { 
                    flagName, 
                    type: 'experimental', 
                    error: error.message,
                    stack: error.stack 
                });
                
                console.error(`[ModeOrchestrator] Experimental feature '${flagName}' failed. Engaging fallback. Error: ${error.message}`);
                // Proceed to fallback
            }
        }

        // Run Fallback
        try {
            const startTime = Date.now();
            const result = await fallbackFn();
            const duration = Date.now() - startTime;
            
            this.emit('executionSuccess', { flagName, type: 'fallback', duration });
            return result;
        } catch (error) {
            this.emit('executionError', { 
                flagName, 
                type: 'fallback', 
                error: error.message 
            });
            console.error(`[ModeOrchestrator] CRITICAL: Fallback execution for '${flagName}' also failed!`);
            throw error; // If fallback fails, we must throw to alert the system.
        }
    }

    /**
     * Synchronous version of executeSafely.
     * 
     * @param {string} flagName - The feature flag controlling the experimental code.
     * @param {Function} experimentalFn - The new/experimental function to run.
     * @param {Function} fallbackFn - The stable/legacy function to run.
     * @param {Object} [context={}] - Context for feature flag evaluation.
     * @returns {any}
     */
    executeSafelySync(flagName, experimentalFn, fallbackFn, context = {}) {
        const isEnabled = this.isFeatureEnabled(flagName, context);

        if (isEnabled) {
            try {
                const result = experimentalFn();
                this.emit('executionSuccess', { flagName, type: 'experimental_sync' });
                return result;
            } catch (error) {
                this.emit('executionError', { flagName, type: 'experimental_sync', error: error.message });
                console.error(`[ModeOrchestrator] Experimental sync feature '${flagName}' failed. Engaging fallback. Error: ${error.message}`);
            }
        }

        try {
            const result = fallbackFn();
            this.emit('executionSuccess', { flagName, type: 'fallback_sync' });
            return result;
        } catch (error) {
            this.emit('executionError', { flagName, type: 'fallback_sync', error: error.message });
            throw error;
        }
    }

    /**
     * Returns a snapshot of all registered flags and their current configurations.
     * Useful for debugging and telemetry payloads.
     * 
     * @returns {Object}
     */
    getRegistrySnapshot() {
        const snapshot = {};
        for (const [name, flag] of this._flags.entries()) {
            snapshot[name] = {
                description: flag.description,
                strategy: flag.strategy,
                defaultValue: flag.defaultValue,
                rolloutPercentage: flag.rolloutPercentage,
                allowedModes: flag.allowedModes,
                currentlyEnabled: this.isFeatureEnabled(name) // Evaluated without specific context
            };
        }
        return {
            mode: this._currentMode,
            flags: snapshot
        };
    }
}

// ============================================================================
// Singleton Export & Default Configuration
// ============================================================================

const modeManager = new ModeOrchestrator();

// Pre-register standard system flags for Git History LLM
modeManager
    .registerFlag('use_advanced_graph_builder', {
        description: 'Enables the new AST-aware commit graph builder.',
        strategy: ROLLOUT_STRATEGIES.PERCENTAGE,
        rolloutPercentage: 10, // Safe rollout to 10% of operations
        allowedModes: [EXECUTION_MODES.DEVELOPMENT, EXECUTION_MODES.BEAST_MODE]
    })
    .registerFlag('enable_deep_intent_deconstruction', {
        description: 'Uses Gemini 1.5 Pro to deeply analyze commit intents instead of Flash.',
        strategy: ROLLOUT_STRATEGIES.BOOLEAN,
        defaultValue: false,
        allowedModes: [EXECUTION_MODES.BEAST_MODE]
    })
    .registerFlag('cache_llm_responses', {
        description: 'Caches LLM responses to prevent redundant API calls on the same commit hash.',
        strategy: ROLLOUT_STRATEGIES.BOOLEAN,
        defaultValue: true
    })
    .registerFlag('parallel_commit_processing', {
        description: 'Processes multiple independent commits concurrently.',
        strategy: ROLLOUT_STRATEGIES.DETERMINISTIC,
        rolloutPercentage: 50 // Deterministic 50% based on repo/branch context
    });

// Export the singleton instance as the default, but also expose classes for testing/extension
module.exports = modeManager;
module.exports.EXECUTION_MODES = EXECUTION_MODES;
module.exports.ROLLOUT_STRATEGIES = ROLLOUT_STRATEGIES;
module.exports.FeatureFlag = FeatureFlag;
module.exports.ModeOrchestrator = ModeOrchestrator;