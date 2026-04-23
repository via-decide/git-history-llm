/**
 * @fileoverview Execution Trace and Time-Travel Debugging Engine
 * @module core/trace
 * @description Provides comprehensive observability, execution trace snapshots, 
 * forensic analysis, and time-travel debugging capabilities for the Git History LLM pipeline.
 * Utilizes AsyncLocalStorage for seamless asynchronous context tracking.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const EventEmitter = require('node:events');
const util = require('node:util');

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generates a unique identifier for trace events and spans.
 * @returns {string} A UUID v4 string.
 */
function generateId() {
    return crypto.randomUUID();
}

/**
 * Safely deep clones an object, handling circular references, Maps, Sets, and Dates.
 * Prevents mutation of trace snapshots by subsequent pipeline steps.
 * @param {any} obj - The object to clone.
 * @returns {any} A safe, deep-cloned representation of the object.
 */
function safeClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    const seen = new WeakMap();

    function cloneRecursively(value) {
        if (value === null || typeof value !== 'object') {
            return value;
        }

        if (seen.has(value)) {
            return '[Circular Reference]';
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const mapCopy = new Map();
            seen.set(value, mapCopy);
            value.forEach((v, k) => {
                mapCopy.set(k, cloneRecursively(v));
            });
            return mapCopy;
        }

        if (value instanceof Set) {
            const setCopy = new Set();
            seen.set(value, setCopy);
            value.forEach((v) => {
                setCopy.add(cloneRecursively(v));
            });
            return setCopy;
        }

        if (value instanceof Error) {
            const errCopy = {
                name: value.name,
                message: value.message,
                stack: value.stack,
            };
            seen.set(value, errCopy);
            return errCopy;
        }

        if (Buffer.isBuffer(value)) {
            return Buffer.from(value);
        }

        const copy = Array.isArray(value) ? [] : {};
        seen.set(value, copy);

        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                copy[key] = cloneRecursively(value[key]);
            }
        }

        return copy;
    }

    try {
        return cloneRecursively(obj);
    } catch (err) {
        return `[Uncloneable Object: ${err.message}]`;
    }
}

/**
 * Calculates a basic structural diff between two objects for state mutation tracking.
 * @param {Object} oldState - The previous state.
 * @param {Object} newState - The new state.
 * @returns {Object} An object representing the delta.
 */
function calculateStateDiff(oldState, newState) {
    const diff = { added: {}, updated: {}, deleted: {} };
    
    const oldKeys = new Set(Object.keys(oldState || {}));
    const newKeys = new Set(Object.keys(newState || {}));

    for (const key of newKeys) {
        if (!oldKeys.has(key)) {
            diff.added[key] = newState[key];
        } else if (JSON.stringify(oldState[key]) !== JSON.stringify(newState[key])) {
            diff.updated[key] = { from: oldState[key], to: newState[key] };
        }
    }

    for (const key of oldKeys) {
        if (!newKeys.has(key)) {
            diff.deleted[key] = oldState[key];
        }
    }

    return diff;
}

// ============================================================================
// Core Trace Models
// ============================================================================

/**
 * Represents a discrete point in time within the execution trace.
 */
class TraceEvent {
    /**
     * @param {string} type - Event type (e.g., 'SPAN_START', 'SPAN_END', 'SNAPSHOT', 'LOG', 'ERROR').
     * @param {string} name - Human-readable name of the event.
     * @param {Object} [payload={}] - Associated data.
     * @param {string|null} [spanId=null] - The ID of the span this event belongs to.
     */
    constructor(type, name, payload = {}, spanId = null) {
        this.id = generateId();
        this.type = type;
        this.name = name;
        this.timestamp = Date.now();
        this.hrtime = performance.now();
        this.payload = safeClone(payload);
        this.spanId = spanId;
    }
}

/**
 * Represents a duration of execution, such as a function call or pipeline stage.
 */
class TraceSpan {
    /**
     * @param {string} name - The name of the operation.
     * @param {string|null} parentId - The ID of the parent span, if any.
     * @param {Object} [tags={}] - Metadata tags for the span.
     */
    constructor(name, parentId = null, tags = {}) {
        this.id = generateId();
        this.name = name;
        this.parentId = parentId;
        this.tags = tags;
        this.startTime = Date.now();
        this.startHrTime = performance.now();
        this.endTime = null;
        this.endHrTime = null;
        this.durationMs = null;
        this.status = 'ACTIVE'; // 'ACTIVE', 'COMPLETED', 'FAILED'
        this.error = null;
    }

    /**
     * Marks the span as completed.
     * @param {Error} [error] - If provided, marks the span as failed.
     */
    end(error = null) {
        this.endTime = Date.now();
        this.endHrTime = performance.now();
        this.durationMs = this.endHrTime - this.startHrTime;
        if (error) {
            this.status = 'FAILED';
            this.error = safeClone(error);
        } else {
            this.status = 'COMPLETED';
        }
    }
}

// ============================================================================
// Execution Tracer
// ============================================================================

/**
 * The primary engine for recording execution traces.
 * Uses AsyncLocalStorage to automatically track span hierarchy across async boundaries.
 */
class ExecutionTracer {
    constructor() {
        this.sessionId = generateId();
        this.startTime = Date.now();
        this.events = [];
        this.spans = new Map();
        this.asyncStorage = new AsyncLocalStorage();
        this.enabled = true;
        this.snapshotFrequency = 'ON_DEMAND'; // 'ON_DEMAND', 'EVERY_STEP'
    }

    /**
     * Globally enables or disables tracing.
     * @param {boolean} state 
     */
    setEnabled(state) {
        this.enabled = !!state;
    }

    /**
     * Retrieves the currently active span from the async context.
     * @returns {TraceSpan|null}
     */
    getCurrentSpan() {
        return this.asyncStorage.getStore() || null;
    }

    /**
     * Records a generic event into the timeline.
     * @param {string} name - Event name.
     * @param {Object} payload - Event data.
     */
    recordEvent(name, payload = {}) {
        if (!this.enabled) return;
        const currentSpan = this.getCurrentSpan();
        const event = new TraceEvent('LOG', name, payload, currentSpan ? currentSpan.id : null);
        this.events.push(event);
    }

    /**
     * Captures a deep snapshot of the provided state object for time-travel debugging.
     * @param {string} label - A descriptive label for the snapshot.
     * @param {Object} state - The application or pipeline state to freeze.
     */
    captureSnapshot(label, state) {
        if (!this.enabled) return;
        const currentSpan = this.getCurrentSpan();
        const event = new TraceEvent('SNAPSHOT', label, { state: safeClone(state) }, currentSpan ? currentSpan.id : null);
        this.events.push(event);
    }

    /**
     * Starts a new trace span. If called within an existing span context, it becomes a child.
     * @param {string} name - Span name.
     * @param {Object} tags - Metadata tags.
     * @returns {TraceSpan} The newly created span.
     */
    startSpan(name, tags = {}) {
        if (!this.enabled) return new TraceSpan(name, null, tags); // Dummy span if disabled

        const parentSpan = this.getCurrentSpan();
        const span = new TraceSpan(name, parentSpan ? parentSpan.id : null, tags);
        this.spans.set(span.id, span);
        
        const event = new TraceEvent('SPAN_START', name, tags, span.id);
        this.events.push(event);

        return span;
    }

    /**
     * Ends an active span.
     * @param {TraceSpan} span - The span to end.
     * @param {Error} [error] - Optional error if the span failed.
     */
    endSpan(span, error = null) {
        if (!this.enabled || !this.spans.has(span.id)) return;

        span.end(error);
        const eventType = error ? 'ERROR' : 'SPAN_END';
        const payload = error ? { error: safeClone(error) } : { duration: span.durationMs };
        
        const event = new TraceEvent(eventType, span.name, payload, span.id);
        this.events.push(event);
    }

    /**
     * Wraps a synchronous or asynchronous function with tracing context.
     * Automatically handles span creation, ending, and error capture.
     * @param {string} name - Name of the operation.
     * @param {Function} fn - The function to trace.
     * @param {Object} [tags={}] - Additional metadata.
     * @returns {Function} A wrapped version of the function.
     */
    trace(name, fn, tags = {}) {
        return (...args) => {
            if (!this.enabled) return fn(...args);

            const span = this.startSpan(name, tags);
            
            // Execute within the AsyncLocalStorage context
            return this.asyncStorage.run(span, () => {
                try {
                    const result = fn(...args);
                    
                    if (result && typeof result.then === 'function') {
                        // Handle Promises
                        return result
                            .then((res) => {
                                this.endSpan(span);
                                return res;
                            })
                            .catch((err) => {
                                this.endSpan(span, err);
                                throw err;
                            });
                    } else {
                        // Handle Synchronous
                        this.endSpan(span);
                        return result;
                    }
                } catch (err) {
                    this.endSpan(span, err);
                    throw err;
                }
            });
        };
    }

    /**
     * Compiles the current trace data into a serializable format.
     * @returns {Object} The complete trace payload.
     */
    getTraceData() {
        return {
            metadata: {
                sessionId: this.sessionId,
                startTime: this.startTime,
                endTime: Date.now(),
                duration: Date.now() - this.startTime,
                environment: process.env.NODE_ENV || 'development',
                platform: process.platform,
                nodeVersion: process.version
            },
            spans: Array.from(this.spans.values()),
            events: this.events
        };
    }

    /**
     * Exports the execution trace to a JSON file for forensic analysis.
     * @param {string} directory - The directory to save the trace file.
     * @param {string} [filename] - Optional custom filename.
     * @returns {string} The full path to the exported file.
     */
    exportTrace(directory, filename = null) {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const name = filename || `trace_${this.sessionId}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const filepath = path.join(directory, name);
        
        const data = this.getTraceData();
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
        
        return filepath;
    }

    /**
     * Clears the current trace history in memory.
     */
    clear() {
        this.events = [];
        this.spans.clear();
        this.sessionId = generateId();
        this.startTime = Date.now();
    }
}

// Global singleton instance for the application
const globalTracer = new ExecutionTracer();

// ============================================================================
// Time-Travel Debugger & Replay Engine
// ============================================================================

/**
 * Engine for loading, parsing, and replaying execution traces step-by-step.
 * Facilitates forensic analysis of pipeline behavior.
 */
class TimeTravelDebugger extends EventEmitter {
    /**
     * @param {Object|string} traceSource - A trace data object or a path to a JSON trace file.
     */
    constructor(traceSource) {
        super();
        this.traceData = this._loadTrace(traceSource);
        this.timeline = this._buildTimeline();
        this.cursor = -1; // -1 means before the first event
        this.currentState = {};
        this.activeSpans = new Set();
    }

    /**
     * Internal method to load trace data.
     * @param {Object|string} source 
     * @returns {Object}
     */
    _loadTrace(source) {
        if (typeof source === 'string') {
            if (!fs.existsSync(source)) {
                throw new Error(`Trace file not found: ${source}`);
            }
            const raw = fs.readFileSync(source, 'utf8');
            return JSON.parse(raw);
        }
        if (typeof source === 'object' && source.events && source.spans) {
            return source;
        }
        throw new Error('Invalid trace source provided.');
    }

    /**
     * Sorts events chronologically and links span data for the replay timeline.
     * @returns {Array} Ordered timeline of events.
     */
    _buildTimeline() {
        const events = [...this.traceData.events].sort((a, b) => a.hrtime - b.hrtime);
        const spanMap = new Map(this.traceData.spans.map(s => [s.id, s]));

        return events.map(event => {
            return {
                ...event,
                spanDetails: event.spanId ? spanMap.get(event.spanId) : null
            };
        });
    }

    /**
     * Gets the total number of steps in the trace.
     * @returns {number}
     */
    get totalSteps() {
        return this.timeline.length;
    }

    /**
     * Gets the current step index.
     * @returns {number}
     */
    get currentStep() {
        return this.cursor;
    }

    /**
     * Resets the replay engine to the beginning.
     */
    reset() {
        this.cursor = -1;
        this.currentState = {};
        this.activeSpans.clear();
        this.emit('reset');
    }

    /**
     * Steps forward by one event in the timeline.
     * @returns {Object|null} The event executed, or null if at the end.
     */
    stepForward() {
        if (this.cursor >= this.timeline.length - 1) {
            return null; // End of trace
        }

        this.cursor++;
        const event = this.timeline[this.cursor];
        this._applyEvent(event, 'forward');
        
        this.emit('step', {
            direction: 'forward',
            cursor: this.cursor,
            event,
            state: this.currentState,
            activeSpans: Array.from(this.activeSpans)
        });

        return event;
    }

    /**
     * Steps backward by one event in the timeline.
     * @returns {Object|null} The event reversed, or null if at the beginning.
     */
    stepBackward() {
        if (this.cursor < 0) {
            return null; // Beginning of trace
        }

        const event = this.timeline[this.cursor];
        this._applyEvent(event, 'backward');
        this.cursor--;

        this.emit('step', {
            direction: 'backward',
            cursor: this.cursor,
            event,
            state: this.currentState,
            activeSpans: Array.from(this.activeSpans)
        });

        return event;
    }

    /**
     * Jumps to a specific index in the timeline.
     * @param {number} targetIndex 
     */
    goToStep(targetIndex) {
        if (targetIndex < -1 || targetIndex >= this.timeline.length) {
            throw new Error(`Target index ${targetIndex} out of bounds.`);
        }

        while (this.cursor < targetIndex) {
            this.stepForward();
        }
        while (this.cursor > targetIndex) {
            this.stepBackward();
        }
    }

    /**
     * Jumps to the nearest snapshot event matching the given label.
     * @param {string} label 
     */
    goToSnapshot(label) {
        const index = this.timeline.findIndex((e, i) => i > this.cursor && e.type === 'SNAPSHOT' && e.name === label);
        if (index !== -1) {
            this.goToStep(index);
            return true;
        }
        // Search backwards if not found forward
        const backIndex = this.timeline.findLastIndex((e, i) => i <= this.cursor && e.type === 'SNAPSHOT' && e.name === label);
        if (backIndex !== -1) {
            this.goToStep(backIndex);
            return true;
        }
        return false;
    }

    /**
     * Internal method to mutate the debugger's state based on the timeline event.
     * @param {Object} event 
     * @param {string} direction 'forward' or 'backward'
     */
    _applyEvent(event, direction) {
        if (direction === 'forward') {
            if (event.type === 'SPAN_START') {
                this.activeSpans.add(event.spanId);
            } else if (event.type === 'SPAN_END' || event.type === 'ERROR') {
                this.activeSpans.delete(event.spanId);
            } else if (event.type === 'SNAPSHOT') {
                // Store previous state in the event for backward travel
                event._previousState = safeClone(this.currentState);
                this.currentState = safeClone(event.payload.state);
            }
        } else if (direction === 'backward') {
            if (event.type === 'SPAN_START') {
                this.activeSpans.delete(event.spanId);
            } else if (event.type === 'SPAN_END' || event.type === 'ERROR') {
                this.activeSpans.add(event.spanId);
            } else if (event.type === 'SNAPSHOT') {
                // Revert to the state before this snapshot was applied
                this.currentState = event._previousState || {};
            }
        }
    }

    /**
     * Automatically plays through the trace at a specified interval.
     * @param {number} speedMs - Milliseconds between steps.
     * @returns {Promise<void>} Resolves when the trace is fully replayed.
     */
    async play(speedMs = 100) {
        return new Promise((resolve) => {
            const timer = setInterval(() => {
                const event = this.stepForward();
                if (!event) {
                    clearInterval(timer);
                    resolve();
                }
            }, speedMs);
            
            // Allow manual interruption
            this.once('stop', () => {
                clearInterval(timer);
                resolve();
            });
        });
    }

    /**
     * Stops an active playback.
     */
    stop() {
        this.emit('stop');
    }

    // --- Forensic Analysis Tools ---

    /**
     * Analyzes the trace to find performance bottlenecks (spans taking unusually long).
     * @param {number} thresholdMs - Minimum duration to be considered a bottleneck.
     * @returns {Array<Object>} List of slow spans.
     */
    findBottlenecks(thresholdMs = 1000) {
        return this.traceData.spans
            .filter(span => span.durationMs >= thresholdMs)
            .sort((a, b) => b.durationMs - a.durationMs);
    }

    /**
     * Extracts all error events from the trace for quick debugging.
     * @returns {Array<Object>} List of error events.
     */
    extractErrors() {
        return this.timeline.filter(e => e.type === 'ERROR');
    }

    /**
     * Compares two snapshots within the trace to identify state mutations.
     * @param {string} snapshotLabelA - The earlier snapshot label.
     * @param {string} snapshotLabelB - The later snapshot label.
     * @returns {Object} The diff showing added, updated, and deleted properties.
     */
    analyzeStateMutation(snapshotLabelA, snapshotLabelB) {
        const snapA = this.timeline.find(e => e.type === 'SNAPSHOT' && e.name === snapshotLabelA);
        const snapB = this.timeline.find(e => e.type === 'SNAPSHOT' && e.name === snapshotLabelB);

        if (!snapA || !snapB) {
            throw new Error('One or both snapshot labels not found in trace.');
        }

        if (snapA.hrtime > snapB.hrtime) {
            console.warn('Warning: snapshotLabelA occurs after snapshotLabelB chronologically.');
        }

        return calculateStateDiff(snapA.payload.state, snapB.payload.state);
    }

    /**
     * Generates a structural tree representation of the execution spans.
     * @returns {Array<Object>} Hierarchical tree of spans.
     */
    getCallTree() {
        const spanMap = new Map();
        const roots = [];

        // Deep clone to avoid mutating original trace data
        const spans = safeClone(this.traceData.spans);

        spans.forEach(span => {
            span.children = [];
            spanMap.set(span.id, span);
        });

        spans.forEach(span => {
            if (span.parentId && spanMap.has(span.parentId)) {
                spanMap.get(span.parentId).children.push(span);
            } else {
                roots.push(span);
            }
        });

        return roots;
    }
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
    tracer: globalTracer,
    ExecutionTracer,
    TimeTravelDebugger,
    TraceEvent,
    TraceSpan,
    utils: {
        generateId,
        safeClone,
        calculateStateDiff
    }
};