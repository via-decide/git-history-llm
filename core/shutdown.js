/**
 * @fileoverview Graceful Shutdown Controller for Git History LLM.
 * 
 * This module provides a robust, priority-based graceful shutdown mechanism.
 * It intercepts system signals (SIGINT, SIGTERM) and fatal errors to ensure
 * safe termination without data loss or system corruption.
 * 
 * Required Features Implemented:
 * - Signal handling (SIGINT, SIGTERM, uncaught exceptions).
 * - Stops intake of new commits immediately upon signal.
 * - Allows current ongoing executions to complete gracefully.
 * - Flushes checkpoint data to preserve state integrity.
 * - Releases locks and system resources safely.
 * - Enforces a strict 5-second timeout, forcing exit if exceeded.
 * 
 * @module core/shutdown
 * @requires events
 */

const EventEmitter = require('events');

/**
 * Priority levels for shutdown tasks.
 * Higher priority tasks execute first.
 * @enum {number}
 */
const ShutdownPriority = {
    /** Phase 1: Stop accepting new commits/jobs immediately */
    INTAKE_STOP: 40,
    /** Phase 2: Wait for currently executing commits/jobs to finish */
    EXECUTION_WAIT: 30,
    /** Phase 3: Flush intermediate state, checkpoints, and caches to disk/DB */
    STATE_FLUSH: 20,
    /** Phase 4: Release distributed locks, close database/network connections */
    RESOURCE_RELEASE: 10
};

/**
 * Maximum allowed time for the entire graceful shutdown sequence.
 * @constant {number}
 */
const GRACEFUL_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} ShutdownTask
 * @property {string} name - Identifier for the task.
 * @property {function(): (Promise<void>|void)} handler - The cleanup logic.
 * @property {number} priority - Execution priority (higher runs first).
 */

class ShutdownController extends EventEmitter {
    constructor() {
        super();
        
        /** @type {boolean} */
        this._isShuttingDown = false;
        
        /** @type {string|null} */
        this._shutdownReason = null;
        
        /** @type {ShutdownTask[]} */
        this._tasks = [];
        
        /** @type {NodeJS.Timeout|null} */
        this._timeoutTimer = null;

        /** @type {boolean} */
        this._signalsBound = false;

        this.bindSignals = this.bindSignals.bind(this);
        this.shutdown = this.shutdown.bind(this);
    }

    /**
     * Binds process-level signal handlers to initiate the graceful shutdown.
     * Should be called once during application initialization.
     */
    bindSignals() {
        if (this._signalsBound) return;

        process.on('SIGINT', () => {
            this._log('Received SIGINT (Ctrl+C). Initiating graceful shutdown...');
            this.shutdown('SIGINT', 0);
        });

        process.on('SIGTERM', () => {
            this._log('Received SIGTERM (Termination signal). Initiating graceful shutdown...');
            this.shutdown('SIGTERM', 0);
        });

        process.on('uncaughtException', (error) => {
            this._log(`CRITICAL: Uncaught Exception: ${error.message}\n${error.stack}`);
            this.shutdown('UNCAUGHT_EXCEPTION', 1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            this._log(`CRITICAL: Unhandled Rejection at: ${promise}, reason: ${reason}`);
            this.shutdown('UNHANDLED_REJECTION', 1);
        });

        this._signalsBound = true;
        this._log('Signal handlers bound successfully.');
    }

    /**
     * Registers a cleanup task to be executed during the shutdown sequence.
     * 
     * @param {string} name - Descriptive name of the cleanup task.
     * @param {number} priority - Use ShutdownPriority enum values.
     * @param {function(): (Promise<void>|void)} handler - The function executing the cleanup.
     * @returns {void}
     */
    registerTask(name, priority, handler) {
        if (this._isShuttingDown) {
            this._log(`Warning: Attempted to register task '${name}' while shutdown is already in progress.`);
            return;
        }

        if (typeof handler !== 'function') {
            throw new TypeError(`Shutdown task handler for '${name}' must be a function.`);
        }

        this._tasks.push({ name, priority, handler });
        
        // Sort tasks descending by priority so highest priority runs first
        this._tasks.sort((a, b) => b.priority - a.priority);
        
        this._log(`Registered shutdown task: [${name}] with priority ${priority}`);
    }

    /**
     * Checks if the system is currently shutting down.
     * Subsystems (like commit intake) should check this before starting new work.
     * 
     * @returns {boolean} True if shutdown is in progress.
     */
    isShuttingDown() {
        return this._isShuttingDown;
    }

    /**
     * Throws an error if the system is shutting down.
     * Useful as a guard clause in critical processing paths.
     * 
     * @throws {Error} If shutdown is in progress.
     */
    ensureNotShuttingDown() {
        if (this._isShuttingDown) {
            throw new Error(`System is currently shutting down (Reason: ${this._shutdownReason}). New operations rejected.`);
        }
    }

    /**
     * Initiates the graceful shutdown sequence.
     * 
     * @param {string} reason - The reason for shutdown (e.g., 'SIGTERM').
     * @param {number} [exitCode=0] - The process exit code to use upon completion.
     * @returns {Promise<void>}
     */
    async shutdown(reason, exitCode = 0) {
        if (this._isShuttingDown) {
            this._log(`Shutdown already in progress (Original reason: ${this._shutdownReason}). Ignoring new request (${reason}).`);
            return;
        }

        this._isShuttingDown = true;
        this._shutdownReason = reason;
        
        this._log(`=== GRACEFUL SHUTDOWN INITIATED ===`);
        this._log(`Reason: ${reason}`);
        this._log(`Timeout: ${GRACEFUL_TIMEOUT_MS}ms`);

        // Emit event so passive listeners can react immediately
        this.emit('shutdownStarted', { reason, exitCode });

        // Enforce maximum timeout
        this._timeoutTimer = setTimeout(() => {
            this._log(`\n[!] SHUTDOWN TIMEOUT EXCEEDED (${GRACEFUL_TIMEOUT_MS}ms) [!]`);
            this._log(`Forcing process exit to prevent hanging. Some state may be lost.`);
            process.exit(1);
        }, GRACEFUL_TIMEOUT_MS);

        // Ensure timer doesn't block the event loop if tasks finish early
        if (this._timeoutTimer.unref) {
            this._timeoutTimer.unref();
        }

        try {
            await this._executeTasksInPriorityGroups();
            this._log(`\n=== GRACEFUL SHUTDOWN COMPLETE ===`);
            this._log(`All resources released and state flushed safely.`);
        } catch (error) {
            this._log(`\n[!] ERROR DURING SHUTDOWN SEQUENCE [!]`);
            this._log(error.stack || error.message);
            exitCode = exitCode === 0 ? 1 : exitCode;
        } finally {
            clearTimeout(this._timeoutTimer);
            this.emit('shutdownComplete', { reason, exitCode });
            
            // Allow standard output to flush before exiting
            setTimeout(() => {
                process.exit(exitCode);
            }, 100).unref();
        }
    }

    /**
     * Executes registered tasks grouped by priority.
     * Tasks within the same priority group are executed concurrently.
     * Priority groups are executed sequentially.
     * 
     * @private
     * @returns {Promise<void>}
     */
    async _executeTasksInPriorityGroups() {
        if (this._tasks.length === 0) {
            this._log('No shutdown tasks registered. Proceeding to exit.');
            return;
        }

        // Group tasks by priority
        const groupedTasks = this._tasks.reduce((acc, task) => {
            if (!acc[task.priority]) acc[task.priority] = [];
            acc[task.priority].push(task);
            return acc;
        }, {});

        // Extract and sort priority levels descending
        const priorities = Object.keys(groupedTasks)
            .map(Number)
            .sort((a, b) => b - a);

        for (const priority of priorities) {
            const tasksInGroup = groupedTasks[priority];
            this._log(`\nExecuting priority group [${priority}] (${tasksInGroup.length} tasks)...`);

            const promises = tasksInGroup.map(async (task) => {
                try {
                    this._log(`  -> Starting task: ${task.name}`);
                    const startTime = Date.now();
                    
                    await Promise.resolve(task.handler());
                    
                    const duration = Date.now() - startTime;
                    this._log(`  <- Completed task: ${task.name} (${duration}ms)`);
                } catch (error) {
                    this._log(`  [X] Failed task: ${task.name} - ${error.message}`);
                    // We catch and log, but do not stop the shutdown sequence for other tasks
                }
            });

            // Wait for all tasks in the current priority group to finish before moving to the next
            await Promise.allSettled(promises);
        }
    }

    /**
     * Internal logger. Can be swapped with a structured logger like Pino/Winston if integrated.
     * @private
     * @param {string} message 
     */
    _log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [SHUTDOWN] ${message}`);
    }
}

// Export a singleton instance for global use across the repository
const globalShutdownController = new ShutdownController();

module.exports = {
    ShutdownController,
    ShutdownPriority,
    shutdownManager: globalShutdownController,
    
    // Convenience exports mapping to the singleton
    bindSignals: () => globalShutdownController.bindSignals(),
    registerTask: (name, priority, handler) => globalShutdownController.registerTask(name, priority, handler),
    isShuttingDown: () => globalShutdownController.isShuttingDown(),
    ensureNotShuttingDown: () => globalShutdownController.ensureNotShuttingDown(),
    triggerShutdown: (reason, exitCode) => globalShutdownController.shutdown(reason, exitCode)
};