/**
 * @fileoverview Core Checkpoint and Recovery Manager for Git History LLM.
 * 
 * This module provides robust, atomic, and cryptographically verified checkpointing
 * capabilities. It ensures zero progress loss during long-running repository analysis
 * pipelines (e.g., commit metadata extraction, graph building, LLM synthesis) by
 * persisting state to disk. Features include atomic writes, automatic backups,
 * integrity hashing, and automatic resumption from the last known good state.
 * 
 * @module core/checkpoint
 * @requires node:fs
 * @requires node:path
 * @requires node:crypto
 * @requires node:events
 * @requires node:os
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const os = require('node:os');

/**
 * @typedef {Object} CheckpointOptions
 * @property {string} [checkpointDir='./.checkpoints'] - Directory to store checkpoint files.
 * @property {string} [jobId='default-job'] - Unique identifier for the current analysis job.
 * @property {number} [saveIntervalMs=5000] - Minimum time between auto-saves (debouncing).
 * @property {number} [maxBackups=3] - Number of rolling backups to keep.
 * @property {boolean} [attachProcessListeners=true] - Whether to auto-save on SIGINT/SIGTERM.
 * @property {string} [hashAlgorithm='sha256'] - Algorithm used for integrity verification.
 */

/**
 * @typedef {Object} JobState
 * @property {string} jobId - The unique job identifier.
 * @property {string} status - Current status ('running', 'paused', 'completed', 'failed').
 * @property {string|null} lastProcessedHash - The SHA of the last successfully processed commit.
 * @property {string[]} processedHashes - Array of commit SHAs that have been fully processed.
 * @property {Object.<string, any>} context - Extensible metadata context (e.g., branch, repo path).
 * @property {Object.<string, string>} errors - Map of commit SHAs to error messages encountered.
 * @property {Object} metrics - Performance and progress metrics.
 * @property {number} metrics.totalProcessed - Total number of commits processed.
 * @property {number} metrics.totalErrors - Total number of errors encountered.
 * @property {number} metrics.startTime - Unix timestamp of when the job started.
 * @property {number} metrics.lastUpdateTime - Unix timestamp of the last checkpoint update.
 */

/**
 * @typedef {Object} CheckpointPayload
 * @property {string} version - Checkpoint schema version.
 * @property {JobState} state - The actual state of the job.
 * @property {Object} environment - Information about the environment where the checkpoint was created.
 * @property {string} signature - Cryptographic hash of the state for integrity verification.
 */

class CheckpointManager extends EventEmitter {
    /**
     * Initializes a new CheckpointManager instance.
     * 
     * @param {CheckpointOptions} options - Configuration options.
     */
    constructor(options = {}) {
        super();
        
        this.options = {
            checkpointDir: path.resolve(process.cwd(), '.checkpoints'),
            jobId: 'default-job',
            saveIntervalMs: 5000,
            maxBackups: 3,
            attachProcessListeners: true,
            hashAlgorithm: 'sha256',
            ...options
        };

        this.checkpointFile = path.join(this.options.checkpointDir, `${this.options.jobId}.ckpt.json`);
        this.lockFile = `${this.checkpointFile}.lock`;
        
        /** @type {JobState} */
        this.state = this._createEmptyState();
        
        this.lastSaveTime = 0;
        this.savePending = false;
        this._saveTimer = null;
        this.isInitialized = false;

        // Bind process handlers so they can be removed later if needed
        this._handleProcessExit = this._handleProcessExit.bind(this);
    }

    /**
     * Creates a fresh, empty state object.
     * 
     * @returns {JobState}
     * @private
     */
    _createEmptyState() {
        return {
            jobId: this.options.jobId,
            status: 'initialized',
            lastProcessedHash: null,
            processedHashes: [],
            context: {},
            errors: {},
            metrics: {
                totalProcessed: 0,
                totalErrors: 0,
                startTime: Date.now(),
                lastUpdateTime: Date.now()
            }
        };
    }

    /**
     * Initializes the checkpoint manager, ensuring directories exist and loading
     * previous state if available.
     * 
     * @returns {Promise<JobState>} The loaded or newly created state.
     * @throws {Error} If directory creation fails or lockfile indicates concurrent access.
     */
    async initialize() {
        if (this.isInitialized) {
            return this.state;
        }

        try {
            // Ensure checkpoint directory exists
            await fsp.mkdir(this.options.checkpointDir, { recursive: true });

            // Check for stale lock file
            await this._acquireLock();

            // Attempt to load existing checkpoint
            const loadedState = await this._loadCheckpoint();
            
            if (loadedState) {
                this.state = loadedState;
                this.state.status = 'resumed';
                this.emit('resumed', this.state);
            } else {
                this.state.status = 'running';
                this.emit('started', this.state);
            }

            if (this.options.attachProcessListeners) {
                this._attachProcessListeners();
            }

            this.isInitialized = true;
            return this.state;

        } catch (error) {
            this.emit('error', new Error(`Initialization failed: ${error.message}`));
            throw error;
        }
    }

    /**
     * Acquires a file-based lock to prevent multiple processes from corrupting the checkpoint.
     * 
     * @private
     */
    async _acquireLock() {
        try {
            const stats = await fsp.stat(this.lockFile);
            // If lockfile is older than 5 minutes, assume it's stale and delete it
            if (Date.now() - stats.mtimeMs > 5 * 60 * 1000) {
                await fsp.unlink(this.lockFile);
                this.emit('warning', 'Removed stale lock file.');
            } else {
                throw new Error(`Lock file exists at ${this.lockFile}. Is another instance running?`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            // ENOENT means no lock file exists, which is good.
        }

        // Create lock file
        await fsp.writeFile(this.lockFile, process.pid.toString(), { flag: 'wx' });
    }

    /**
     * Releases the file-based lock.
     * 
     * @private
     */
    async _releaseLock() {
        try {
            await fsp.unlink(this.lockFile);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.emit('error', new Error(`Failed to release lock: ${error.message}`));
            }
        }
    }

    /**
     * Releases the lock synchronously (used during process exit).
     * 
     * @private
     */
    _releaseLockSync() {
        try {
            if (fs.existsSync(this.lockFile)) {
                fs.unlinkSync(this.lockFile);
            }
        } catch (error) {
            // Swallow errors during sync exit
        }
    }

    /**
     * Loads and verifies an existing checkpoint file.
     * 
     * @returns {Promise<JobState|null>} The parsed state, or null if none exists.
     * @private
     */
    async _loadCheckpoint() {
        try {
            const fileContent = await fsp.readFile(this.checkpointFile, 'utf8');
            const payload = JSON.parse(fileContent);

            if (!this._verifyIntegrity(payload)) {
                throw new Error('Checkpoint integrity verification failed. File may be corrupted.');
            }

            return payload.state;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // No checkpoint exists yet
            }
            
            this.emit('warning', `Failed to load primary checkpoint: ${error.message}. Attempting to load backup...`);
            return await this._loadLatestBackup();
        }
    }

    /**
     * Attempts to load the most recent valid backup if the primary checkpoint is corrupted.
     * 
     * @returns {Promise<JobState|null>}
     * @private
     */
    async _loadLatestBackup() {
        for (let i = 1; i <= this.options.maxBackups; i++) {
            const backupFile = `${this.checkpointFile}.bak${i}`;
            try {
                const fileContent = await fsp.readFile(backupFile, 'utf8');
                const payload = JSON.parse(fileContent);
                
                if (this._verifyIntegrity(payload)) {
                    this.emit('info', `Successfully recovered from backup: ${backupFile}`);
                    return payload.state;
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    this.emit('warning', `Backup ${backupFile} also invalid/corrupted.`);
                }
            }
        }
        
        throw new Error('All checkpoints and backups are missing or corrupted. Cannot resume.');
    }

    /**
     * Generates a cryptographic hash for the given state object.
     * 
     * @param {JobState} state - The state to hash.
     * @returns {string} Hex string of the hash.
     * @private
     */
    _generateSignature(state) {
        const hash = crypto.createHash(this.options.hashAlgorithm);
        // Stringify with stable keys to ensure consistent hashing
        const stableString = JSON.stringify(state, Object.keys(state).sort());
        hash.update(stableString);
        return hash.digest('hex');
    }

    /**
     * Verifies the integrity of a checkpoint payload.
     * 
     * @param {CheckpointPayload} payload - The payload to verify.
     * @returns {boolean} True if valid, false otherwise.
     * @private
     */
    _verifyIntegrity(payload) {
        if (!payload || !payload.state || !payload.signature) return false;
        const expectedSignature = this._generateSignature(payload.state);
        return expectedSignature === payload.signature;
    }

    /**
     * Constructs the full payload wrapper for the current state.
     * 
     * @returns {CheckpointPayload}
     * @private
     */
    _buildPayload() {
        this.state.metrics.lastUpdateTime = Date.now();
        return {
            version: '1.0.0',
            state: this.state,
            environment: {
                platform: os.platform(),
                arch: os.arch(),
                nodeVersion: process.version,
                pid: process.pid,
                timestamp: new Date().toISOString()
            },
            signature: this._generateSignature(this.state)
        };
    }

    /**
     * Rotates existing backup files to maintain the configured maximum limit.
     * 
     * @private
     */
    async _rotateBackups() {
        try {
            // Shift backups: bak2 -> bak3, bak1 -> bak2, checkpoint -> bak1
            for (let i = this.options.maxBackups - 1; i >= 1; i--) {
                const oldPath = `${this.checkpointFile}.bak${i}`;
                const newPath = `${this.checkpointFile}.bak${i + 1}`;
                try {
                    await fsp.rename(oldPath, newPath);
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
            }
            
            // Move current to bak1
            try {
                await fsp.rename(this.checkpointFile, `${this.checkpointFile}.bak1`);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        } catch (error) {
            this.emit('warning', `Failed to rotate backups: ${error.message}`);
        }
    }

    /**
     * Persists the current state to disk using an atomic write strategy.
     * 
     * @param {boolean} [force=false] - If true, bypasses the debounce interval.
     * @returns {Promise<void>}
     */
    async save(force = false) {
        if (!this.isInitialized) {
            throw new Error('CheckpointManager is not initialized. Call initialize() first.');
        }

        const now = Date.now();
        if (!force && now - this.lastSaveTime < this.options.saveIntervalMs) {
            this.savePending = true;
            if (!this._saveTimer) {
                this._saveTimer = setTimeout(() => {
                    this._saveTimer = null;
                    this.save(true);
                }, this.options.saveIntervalMs - (now - this.lastSaveTime));
            }
            return;
        }

        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }

        this.savePending = false;
        this.lastSaveTime = now;

        const payload = this._buildPayload();
        const tempFile = `${this.checkpointFile}.tmp.${process.pid}`;

        try {
            // 1. Rotate backups
            await this._rotateBackups();

            // 2. Write to temp file
            await fsp.writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8');

            // 3. Atomic rename
            await fsp.rename(tempFile, this.checkpointFile);

            this.emit('saved', this.state);
        } catch (error) {
            this.emit('error', new Error(`Failed to save checkpoint: ${error.message}`));
            // Cleanup temp file if possible
            try {
                await fsp.unlink(tempFile);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * Synchronous version of save(), intended for use during fatal crashes or process exit.
     * Uses graceful degradation for file system operations.
     */
    saveSync() {
        if (!this.isInitialized) return;

        try {
            const payload = this._buildPayload();
            const tempFile = `${this.checkpointFile}.tmp.sync.${process.pid}`;

            // Sync backup rotation (simplified to just 1 backup for speed during exit)
            if (fs.existsSync(this.checkpointFile)) {
                const backupFile = `${this.checkpointFile}.bak1`;
                if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
                fs.renameSync(this.checkpointFile, backupFile);
            }

            fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tempFile, this.checkpointFile);
            
            this.emit('savedSync', this.state);
        } catch (error) {
            // Cannot throw asynchronously here, just log to stderr
            console.error(`[CheckpointManager] FATAL: Failed to synchronously save checkpoint: ${error.message}`);
        } finally {
            this._releaseLockSync();
        }
    }

    /**
     * Records a commit as successfully processed.
     * 
     * @param {string} commitHash - The SHA of the commit.
     * @param {Object} [metadata={}] - Optional metadata generated during processing (e.g. graph nodes).
     * @returns {Promise<void>}
     */
    async recordCommit(commitHash, metadata = {}) {
        if (!this.state.processedHashes.includes(commitHash)) {
            this.state.processedHashes.push(commitHash);
            this.state.metrics.totalProcessed++;
        }
        
        this.state.lastProcessedHash = commitHash;
        
        // Store lightweight metadata if provided, keeping checkpoint size manageable
        if (Object.keys(metadata).length > 0) {
            if (!this.state.context.commitData) {
                this.state.context.commitData = {};
            }
            this.state.context.commitData[commitHash] = metadata;
        }

        // Remove from errors if it previously failed but now succeeded
        if (this.state.errors[commitHash]) {
            delete this.state.errors[commitHash];
            this.state.metrics.totalErrors = Object.keys(this.state.errors).length;
        }

        await this.save();
    }

    /**
     * Records an error that occurred while processing a specific commit.
     * 
     * @param {string} commitHash - The SHA of the commit that failed.
     * @param {Error|string} error - The error encountered.
     * @returns {Promise<void>}
     */
    async recordError(commitHash, error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        this.state.errors[commitHash] = {
            message: errorMessage,
            timestamp: new Date().toISOString(),
            stack: error instanceof Error ? error.stack : undefined
        };
        
        this.state.metrics.totalErrors = Object.keys(this.state.errors).length;
        this.emit('commitError', { commitHash, error: errorMessage });
        
        await this.save(true); // Force save on error
    }

    /**
     * Checks if a specific commit has already been processed successfully.
     * 
     * @param {string} commitHash - The SHA of the commit to check.
     * @returns {boolean} True if processed, false otherwise.
     */
    isProcessed(commitHash) {
        return this.state.processedHashes.includes(commitHash);
    }

    /**
     * Retrieves the array of successfully processed commit hashes.
     * 
     * @returns {string[]}
     */
    getProcessedCommits() {
        return [...this.state.processedHashes];
    }

    /**
     * Retrieves commits that encountered errors and need reprocessing.
     * 
     * @returns {string[]} Array of commit hashes.
     */
    getFailedCommits() {
        return Object.keys(this.state.errors);
    }

    /**
     * Updates arbitrary context data in the checkpoint.
     * Useful for tracking graph building progress, branch states, etc.
     * 
     * @param {string} key - Context key.
     * @param {any} value - Context value (must be JSON serializable).
     * @returns {Promise<void>}
     */
    async updateContext(key, value) {
        this.state.context[key] = value;
        await this.save();
    }

    /**
     * Retrieves context data.
     * 
     * @param {string} key - Context key.
     * @returns {any} The context value, or undefined.
     */
    getContext(key) {
        return this.state.context[key];
    }

    /**
     * Marks the entire job as successfully completed.
     * Cleans up the checkpoint files as they are no longer needed for resumption.
     * 
     * @returns {Promise<void>}
     */
    async markCompleted() {
        this.state.status = 'completed';
        this.emit('completed', this.state);
        
        // Optional: Save a final summary before cleanup
        const summaryFile = path.join(this.options.checkpointDir, `${this.options.jobId}.summary.json`);
        await fsp.writeFile(summaryFile, JSON.stringify(this.state.metrics, null, 2));

        await this.clear();
    }

    /**
     * Clears all checkpoint data, backups, and locks for the current job.
     * 
     * @returns {Promise<void>}
     */
    async clear() {
        this._removeProcessListeners();
        
        const filesToDelete = [
            this.checkpointFile,
            this.lockFile,
            ...Array.from({ length: this.options.maxBackups }, (_, i) => `${this.checkpointFile}.bak${i + 1}`)
        ];

        for (const file of filesToDelete) {
            try {
                await fsp.unlink(file);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    this.emit('warning', `Failed to delete checkpoint file during cleanup: ${file}`);
                }
            }
        }

        this.state = this._createEmptyState();
        this.isInitialized = false;
        this.emit('cleared');
    }

    /**
     * Attaches listeners to process events to ensure checkpoints are saved on exit.
     * 
     * @private
     */
    _attachProcessListeners() {
        process.on('SIGINT', this._handleProcessExit);
        process.on('SIGTERM', this._handleProcessExit);
        process.on('uncaughtException', this._handleUncaughtException.bind(this));
        process.on('exit', this._handleProcessExit);
    }

    /**
     * Removes process listeners.
     * 
     * @private
     */
    _removeProcessListeners() {
        process.removeListener('SIGINT', this._handleProcessExit);
        process.removeListener('SIGTERM', this._handleProcessExit);
        process.removeListener('exit', this._handleProcessExit);
    }

    /**
     * Handles process termination signals.
     * 
     * @private
     */
    _handleProcessExit() {
        if (this.state.status !== 'completed') {
            this.state.status = 'paused';
            this.saveSync();
        } else {
            this._releaseLockSync();
        }
        process.exit(0);
    }

    /**
     * Handles uncaught exceptions, ensuring state is saved before crashing.
     * 
     * @param {Error} error 
     * @private
     */
    _handleUncaughtException(error) {
        this.state.status = 'failed';
        this.state.context.fatalError = {
            message: error.message,
            stack: error.stack,
            time: new Date().toISOString()
        };
        
        console.error('\n[CheckpointManager] FATAL UNCAUGHT EXCEPTION. Saving state and terminating...');
        console.error(error);
        
        this.saveSync();
        process.exit(1);
    }
}

module.exports = {
    CheckpointManager
};