/**
 * @fileoverview Git History LLM Core - Schema & Pipeline
 * @module @git-history-llm/core
 * 
 * This module provides a deterministic, automated commit intelligence pipeline.
 * It replaces manual prompt-based workflows with structured, repeatable, and
 * automatable commit summarization, work pattern categorization, and change
 * graph generation.
 * 
 * NOTE: This file encompasses both schema definitions (core/schema.js) and 
 * pipeline orchestration (core/pipeline.js) to ensure atomic deployment and
 * strict execution environments.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

// ============================================================================
// PART 1: CORE SCHEMA & VALIDATION ENGINE (core/schema.js)
// ============================================================================

/**
 * Custom Error classes for the pipeline
 */
export class SchemaValidationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SchemaValidationError';
        this.details = details;
    }
}

export class GitExecutionError extends Error {
    constructor(message, command) {
        super(`Git Error: ${message}`);
        this.name = 'GitExecutionError';
        this.command = command;
    }
}

export class LLMInferenceError extends Error {
    constructor(message, status) {
        super(`LLM Inference Error: ${message}`);
        this.name = 'LLMInferenceError';
        this.status = status;
    }
}

/**
 * Lightweight deterministic schema validator for LLM structured outputs.
 * Enforces strict typing without requiring external dependencies like Zod,
 * making the pipeline robust and portable.
 */
export class Schema {
    static validate(data, schema, path = 'root') {
        if (schema === String) {
            if (typeof data !== 'string') throw new SchemaValidationError(`Expected string at ${path}, got ${typeof data}`);
            return data;
        }
        if (schema === Number) {
            if (typeof data !== 'number') throw new SchemaValidationError(`Expected number at ${path}, got ${typeof data}`);
            return data;
        }
        if (schema === Boolean) {
            if (typeof data !== 'boolean') throw new SchemaValidationError(`Expected boolean at ${path}, got ${typeof data}`);
            return data;
        }
        if (Array.isArray(schema)) {
            if (!Array.isArray(data)) throw new SchemaValidationError(`Expected array at ${path}, got ${typeof data}`);
            return data.map((item, index) => Schema.validate(item, schema[0], `${path}[${index}]`));
        }
        if (typeof schema === 'object' && schema !== null) {
            if (typeof data !== 'object' || data === null) {
                throw new SchemaValidationError(`Expected object at ${path}, got ${typeof data}`);
            }
            const validated = {};
            for (const [key, typeDef] of Object.entries(schema)) {
                if (data[key] === undefined) {
                    // Check if it's an optional field (denoted by a specific wrapper, simplified here)
                    if (typeDef.optional) continue;
                    throw new SchemaValidationError(`Missing required field: ${key} at ${path}`);
                }
                validated[key] = Schema.validate(data[key], typeDef, `${path}.${key}`);
            }
            return validated;
        }
        return data;
    }

    /**
     * Defines an optional field in the schema
     */
    static optional(type) {
        return { type, optional: true };
    }

    /**
     * Defines an enum field
     */
    static enum(values) {
        return {
            __isEnum: true,
            values,
            validate: (data, path) => {
                if (!values.includes(data)) {
                    throw new SchemaValidationError(`Expected one of [${values.join(', ')}] at ${path}, got ${data}`);
                }
                return data;
            }
        };
    }
}

/**
 * System Schemas defining the exact expected structure for LLM JSON generation
 */
export const CommitIntelligenceSchema = {
    summary: String,
    work_patterns: Schema.enum(['feature', 'bugfix', 'refactor', 'chore', 'docs', 'security', 'performance', 'mixed']),
    risk_assessment: Schema.enum(['low', 'medium', 'high', 'critical']),
    impact_score: Number, // 1-10 scale
    key_changes: [String],
    dependencies_affected: [String],
    architectural_impact: String
};

export const BatchIntelligenceSchema = {
    batch_id: String,
    overall_summary: String,
    primary_focus: String,
    commits_analyzed: Number,
    categorized_commits: [{
        hash: String,
        category: String,
        reasoning: String
    }],
    change_graph_edges: [{
        source_file: String,
        target_file: String,
        coupling_strength: Number, // 1-10
        reason: String
    }],
    anomalies_detected: [String]
};


// ============================================================================
// PART 2: AUTOMATED COMMIT PIPELINE (core/pipeline.js)
// ============================================================================

/**
 * Logger utility for deterministic pipeline tracing
 */
class PipelineLogger {
    constructor(level = 'INFO') {
        this.levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
        this.currentLevel = this.levels[level] || 1;
    }

    _log(level, message, meta = {}) {
        if (this.levels[level] >= this.currentLevel) {
            const timestamp = new Date().toISOString();
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
            console.log(`[${timestamp}] [${level}] ${message} ${metaStr}`);
        }
    }

    debug(msg, meta) { this._log('DEBUG', msg, meta); }
    info(msg, meta) { this._log('INFO', msg, meta); }
    warn(msg, meta) { this._log('WARN', msg, meta); }
    error(msg, meta) { this._log('ERROR', msg, meta); }
}

/**
 * Antigravity Commit Intelligence Pipeline
 * Orchestrates Git history extraction, graph building, and deterministic LLM synthesis.
 */
export class GitIntelligencePipeline {
    /**
     * @param {Object} config - Pipeline configuration
     * @param {string} config.repoPath - Absolute path to the git repository
     * @param {string} config.llmApiKey - API key for the LLM provider
     * @param {string} config.llmProvider - 'gemini', 'openai', or 'anthropic'
     * @param {string} config.model - Specific model version (e.g., 'gemini-1.5-pro')
     * @param {number} config.maxRetries - Number of times to retry failed LLM calls
     */
    constructor(config = {}) {
        this.repoPath = config.repoPath || process.cwd();
        this.llmApiKey = config.llmApiKey || process.env.LLM_API_KEY;
        this.llmProvider = config.llmProvider || 'gemini';
        this.model = config.model || 'gemini-1.5-pro';
        this.maxRetries = config.maxRetries || 3;
        this.logger = new PipelineLogger(config.logLevel || 'INFO');

        if (!this.llmApiKey) {
            this.logger.warn('No LLM API key provided. Pipeline will fail at the inference stage if not mocked.');
        }
    }

    /**
     * Extracts raw commit history using a strict, easily parsable delimiter format.
     * @param {number} limit - Number of commits to fetch
     * @param {string} branch - Branch to analyze (default: HEAD)
     * @returns {Promise<Array<Object>>} Array of parsed commit objects
     */
    async extractGitHistory(limit = 50, branch = 'HEAD') {
        this.logger.info(`Extracting git history from ${this.repoPath}`, { limit, branch });
        
        // Custom delimiter to prevent parsing errors from commit messages containing standard delimiters
        const DELIMITER = '||__GIT_LLM_DELIM__||';
        const format = `%H${DELIMITER}%an${DELIMITER}%ae${DELIMITER}%aI${DELIMITER}%s${DELIMITER}%b`;
        
        const command = `git -C "${this.repoPath}" log ${branch} -n ${limit} --pretty=format:"${format}" --name-status`;
        
        try {
            const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer for large histories
            return this._parseGitLog(stdout, DELIMITER);
        } catch (error) {
            this.logger.error('Failed to extract git history', { error: error.message });
            throw new GitExecutionError(error.message, command);
        }
    }

    /**
     * Parses the raw stdout from git log into structured JavaScript objects.
     * @param {string} rawOutput - Raw stdout from git
     * @param {string} delimiter - The delimiter used in the git log format
     * @returns {Array<Object>}
     * @private
     */
    _parseGitLog(rawOutput, delimiter) {
        if (!rawOutput.trim()) return [];

        const commits = [];
        // Git log with --name-status separates commits by double newlines generally, 
        // but it's safer to split by the known hash pattern or reconstruct sequentially.
        const lines = rawOutput.split('\n');
        
        let currentCommit = null;

        for (const line of lines) {
            if (line.includes(delimiter)) {
                // This is a commit header line
                if (currentCommit) {
                    commits.push(currentCommit);
                }
                const [hash, author, email, date, subject, body] = line.split(delimiter);
                currentCommit = {
                    hash,
                    author,
                    email,
                    date,
                    subject,
                    body: body ? body.trim() : '',
                    files: []
                };
            } else if (line.trim() !== '') {
                // This is a file status line (e.g., "M\tcore/pipeline.js")
                if (currentCommit) {
                    const [status, ...fileParts] = line.split('\t');
                    const file = fileParts.join('\t'); // Rejoin in case of tabs in filenames (rare but possible)
                    if (status && file) {
                        currentCommit.files.push({ status: status.charAt(0), file });
                    }
                }
            }
        }
        
        if (currentCommit) {
            commits.push(currentCommit);
        }

        this.logger.debug(`Parsed ${commits.length} commits successfully.`);
        return commits;
    }

    /**
     * Builds a logical coupling graph based on files changed together in commits.
     * @param {Array<Object>} commits - Array of parsed commit objects
     * @returns {Object} Graph representation (nodes and edges)
     */
    buildChangeGraph(commits) {
        this.logger.info('Building change dependency graph...');
        const graph = {
            nodes: new Set(),
            edges: new Map() // 'fileA|fileB' -> weight
        };

        for (const commit of commits) {
            const files = commit.files.map(f => f.file);
            files.forEach(f => graph.nodes.add(f));

            // Create edges for all pairs of files in this commit
            for (let i = 0; i < files.length; i++) {
                for (let j = i + 1; j < files.length; j++) {
                    // Sort to ensure undirected graph consistency
                    const [f1, f2] = [files[i], files[j]].sort();
                    const edgeKey = `${f1}|${f2}`;
                    
                    const currentWeight = graph.edges.get(edgeKey) || 0;
                    graph.edges.set(edgeKey, currentWeight + 1);
                }
            }
        }

        // Format for output
        const formattedEdges = Array.from(graph.edges.entries())
            .map(([key, weight]) => {
                const [source, target] = key.split('|');
                return { source, target, weight };
            })
            .filter(edge => edge.weight > 1) // Only keep meaningful couplings
            .sort((a, b) => b.weight - a.weight);

        return {
            nodes: Array.from(graph.nodes),
            edges: formattedEdges
        };
    }

    /**
     * Constructs the deterministic prompt for the LLM based on the batch data.
     * Enforces JSON output strictly mapping to the schema.
     * @param {Array<Object>} commits 
     * @param {Object} graph 
     * @returns {string} System prompt
     * @private
     */
    _buildSystemPrompt() {
        return `You are the Git History LLM Intelligence Engine.
Your purpose is to analyze git commit histories, categorize work patterns, assess risk, and output deterministic structured data.
You MUST output ONLY valid JSON. No markdown formatting, no code blocks, no conversational text.
Your output must strictly adhere to the following JSON schema:

{
  "batch_id": "string",
  "overall_summary": "string (executive summary of all changes)",
  "primary_focus": "string (the main architectural or feature focus)",
  "commits_analyzed": number,
  "categorized_commits": [
    {
      "hash": "string",
      "category": "feature|bugfix|refactor|chore|docs|security|performance|mixed",
      "reasoning": "string (brief justification)"
    }
  ],
  "change_graph_edges": [
    {
      "source_file": "string",
      "target_file": "string",
      "coupling_strength": number (1-10),
      "reason": "string (why these files are logically coupled based on the commits)"
    }
  ],
  "anomalies_detected": ["string (e.g., unusually large commits, sensitive files touched, out-of-pattern changes)"]
}

Analyze the provided commit metadata and change graph carefully. Be objective and precise.`;
    }

    /**
     * Executes the LLM inference with exponential backoff and schema validation.
     * @param {Array<Object>} commits 
     * @param {Object} graph 
     * @returns {Promise<Object>} Validated intelligence report
     */
    async generateIntelligenceReport(commits, graph) {
        this.logger.info('Initiating LLM Intelligence Synthesis...');
        
        const payload = {
            metadata: {
                total_commits: commits.length,
                date_range: {
                    start: commits[commits.length - 1]?.date,
                    end: commits[0]?.date
                }
            },
            commits: commits.map(c => ({
                hash: c.hash,
                author: c.author,
                subject: c.subject,
                body: c.body,
                files_changed: c.files.map(f => `${f.status} ${f.file}`)
            })),
            frequent_couplings: graph.edges.slice(0, 10) // Send top 10 edges to save tokens
        };

        const systemPrompt = this._buildSystemPrompt();
        const userPrompt = JSON.stringify(payload, null, 2);

        let attempt = 0;
        let delay = 1000;

        while (attempt < this.maxRetries) {
            try {
                attempt++;
                this.logger.debug(`LLM Inference attempt ${attempt}/${this.maxRetries}`);
                
                const rawResponse = await this._callLLMProvider(systemPrompt, userPrompt);
                const cleanJson = this._sanitizeLLMResponse(rawResponse);
                
                const parsedData = JSON.parse(cleanJson);
                
                // Deterministic Schema Validation
                const validatedData = Schema.validate(parsedData, BatchIntelligenceSchema, 'BatchIntelligence');
                
                this.logger.info('Intelligence Report generated and validated successfully.');
                return validatedData;

            } catch (error) {
                this.logger.warn(`Attempt ${attempt} failed: ${error.message}`);
                if (attempt >= this.maxRetries) {
                    this.logger.error('Max retries reached. Pipeline failed.');
                    throw new LLMInferenceError(`Failed to generate valid report after ${this.maxRetries} attempts. Last error: ${error.message}`);
                }
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
            }
        }
    }

    /**
     * Strips markdown formatting (like ```json ... ```) that LLMs frequently prepend/append.
     * @param {string} response 
     * @returns {string} Clean JSON string
     * @private
     */
    _sanitizeLLMResponse(response) {
        let clean = response.trim();
        if (clean.startsWith('```json')) {
            clean = clean.substring(7);
        } else if (clean.startsWith('```')) {
            clean = clean.substring(3);
        }
        if (clean.endsWith('```')) {
            clean = clean.substring(0, clean.length - 3);
        }
        return clean.trim();
    }

    /**
     * Internal abstraction for calling different LLM providers.
     * Currently mocks the network request, but structured for easy replacement 
     * with official SDKs (@google/genai, openai, etc.).
     * @param {string} system 
     * @param {string} user 
     * @returns {Promise<string>}
     * @private
     */
    async _callLLMProvider(system, user) {
        if (!this.llmApiKey) {
            throw new Error("API Key is missing. Cannot route to LLM provider.");
        }

        // Example implementation for a generic REST endpoint (e.g., Gemini REST API)
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.llmApiKey}`;
        
        const requestBody = {
            contents: [
                { role: "user", parts: [{ text: `${system}\n\nDATA:\n${user}` }] }
            ],
            generationConfig: {
                temperature: 0.1, // Low temperature for deterministic output
                responseMimeType: "application/json"
            }
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new LLMInferenceError(`API HTTP Error ${response.status}: ${errText}`, response.status);
        }

        const data = await response.json();
        
        // Extract text from Gemini response structure
        if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
            return data.candidates[0].content.parts[0].text;
        }

        throw new LLMInferenceError("Unexpected response structure from LLM provider");
    }

    /**
     * Main orchestration method. Runs the entire pipeline end-to-end.
     * @param {Object} options 
     * @param {number} options.limit - Number of commits to analyze
     * @param {string} options.branch - Branch to analyze
     * @param {string} options.outputPath - Optional path to save the JSON report
     * @returns {Promise<Object>} The final intelligence report
     */
    async run(options = {}) {
        const { limit = 20, branch = 'HEAD', outputPath = null } = options;
        
        this.logger.info('--- Starting Git History LLM Pipeline ---');
        
        try {
            // 1. Extract
            const commits = await this.extractGitHistory(limit, branch);
            if (commits.length === 0) {
                this.logger.warn('No commits found in the specified range.');
                return null;
            }

            // 2. Analyze & Graph
            const graph = this.buildChangeGraph(commits);
            
            // 3. Synthesize via LLM
            // Generate a unique batch ID
            const batchId = crypto.createHash('sha256')
                .update(commits.map(c => c.hash).join(''))
                .digest('hex')
                .substring(0, 12);

            const report = await this.generateIntelligenceReport(commits, graph);
            report.batch_id = batchId;

            // 4. Output
            if (outputPath) {
                const fullPath = path.resolve(outputPath);
                await fs.writeFile(fullPath, JSON.stringify(report, null, 2), 'utf8');
                this.logger.info(`Report saved to ${fullPath}`);
            }

            this.logger.info('--- Pipeline Execution Complete ---');
            return report;

        } catch (error) {
            this.logger.error('Pipeline execution failed entirely.', { error: error.stack });
            throw error;
        }
    }
}

// Export default instance factory
export function createPipeline(config) {
    return new GitIntelligencePipeline(config);
}