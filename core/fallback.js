/**
 * @file core/fallback.js
 * @description Multi-level fallback engine and degraded execution mode for Git History LLM.
 * Ensures the system produces usable summaries and structured insights even during 
 * catastrophic LLM failures, rate limits, or network timeouts.
 * 
 * LEVELS OF DEGRADATION:
 * - LEVEL 1: Standard Retry (Exponential backoff with jitter)
 * - LEVEL 2: Simplified Prompt (Reduced variability, lower token count, lower cognitive load for LLM)
 * - LEVEL 3: Rule-Based Summarizer (Zero-LLM heuristic extraction based on commit metadata and diffs)
 * 
 * @module core/fallback
 * @author Antigravity Synthesis Orchestrator
 * @version 3.0.0
 */

const EventEmitter = require('events');

/**
 * Custom error class for Fallback Engine operations.
 */
class FallbackError extends Error {
    /**
     * @param {string} message - Error description
     * @param {string} level - The fallback level where the error occurred
     * @param {Error} [originalError] - The underlying error that triggered this
     */
    constructor(message, level, originalError = null) {
        super(message);
        this.name = 'FallbackError';
        this.level = level;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * Constants for the Fallback Engine
 */
const FALLBACK_CONSTANTS = {
    MAX_RETRIES_LEVEL_1: 3,
    BASE_DELAY_MS: 1000,
    MAX_DELAY_MS: 10000,
    TIMEOUT_MS: 30000,
    LEVELS: {
        PRIMARY: 'PRIMARY_LLM',
        LEVEL_1: 'RETRY_BACKOFF',
        LEVEL_2: 'SIMPLIFIED_PROMPT',
        LEVEL_3: 'RULE_BASED'
    }
};

/**
 * Heuristic analyzer for Level 3 zero-LLM fallback.
 * Uses regex, file path analysis, and metadata scoring to generate structured JSON.
 */
class RuleBasedSummarizer {
    constructor(logger) {
        this.logger = logger;
        
        // Conventional commit patterns
        this.commitTypes = {
            feat: { category: 'Feature', risk: 'Medium', weight: 3 },
            fix: { category: 'Bugfix', risk: 'Low', weight: 2 },
            chore: { category: 'Maintenance', risk: 'Low', weight: 1 },
            refactor: { category: 'Refactor', risk: 'Medium', weight: 2 },
            docs: { category: 'Documentation', risk: 'None', weight: 0 },
            test: { category: 'Testing', risk: 'Low', weight: 1 },
            perf: { category: 'Performance', risk: 'Medium', weight: 2 },
            ci: { category: 'DevOps/CI', risk: 'High', weight: 3 },
            build: { category: 'Build System', risk: 'High', weight: 3 },
            revert: { category: 'Revert', risk: 'High', weight: 4 }
        };

        // High risk file patterns
        this.criticalFiles = [
            /package\.json$/,
            /yarn\.lock$/,
            /package-lock\.json$/,
            /docker-compose.*\.yml$/,
            /Dockerfile$/,
            /\.github\/workflows/,
            /\.env/,
            /config\//,
            /security/i,
            /auth/i
        ];
    }

    /**
     * Extracts issue references (e.g., #123, JIRA-456) from text.
     * @param {string} text - The commit message
     * @returns {string[]} Array of issue tags
     */
    _extractIssueTags(text) {
        const issues = [];
        const githubRegex = /#(\d+)/g;
        const jiraRegex = /[A-Z]{2,10}-\d+/g;
        
        let match;
        while ((match = githubRegex.exec(text)) !== null) {
            issues.push(`GH-${match[1]}`);
        }
        while ((match = jiraRegex.exec(text)) !== null) {
            issues.push(match[0]);
        }
        return [...new Set(issues)];
    }

    /**
     * Determines the domain/module of the changes based on file paths.
     * @param {string[]} files - Array of changed file paths
     * @returns {string[]} Array of affected domains
     */
    _analyzeDomains(files) {
        const domains = new Set();
        for (const file of (files || [])) {
            if (file.includes('src/components') || file.includes('ui/')) domains.add('Frontend/UI');
            if (file.includes('src/api') || file.includes('routes/')) domains.add('API/Network');
            if (file.includes('db/') || file.includes('models/')) domains.add('Database/Models');
            if (file.includes('tests/') || file.includes('spec.')) domains.add('Testing');
            if (file.includes('core/') || file.includes('engine/')) domains.add('Core/Engine');
        }
        return domains.size > 0 ? Array.from(domains) : ['General'];
    }

    /**
     * Calculates a risk score (1-10) based on commit metadata.
     * @param {Object} parsedCommit - The parsed commit data
     * @param {string[]} files - Changed files
     * @param {number} changes - Total additions + deletions
     * @returns {number} Risk score
     */
    _calculateRiskScore(parsedCommit, files, changes) {
        let score = 1;

        // Factor 1: Commit Type
        if (parsedCommit && this.commitTypes[parsedCommit.type]) {
            score += this.commitTypes[parsedCommit.type].weight;
        }

        // Factor 2: Volume of changes
        if (changes > 1000) score += 4;
        else if (changes > 500) score += 3;
        else if (changes > 100) score += 2;
        else if (changes > 50) score += 1;

        // Factor 3: Critical files touched
        let criticalTouches = 0;
        for (const file of (files || [])) {
            if (this.criticalFiles.some(regex => regex.test(file))) {
                criticalTouches++;
            }
        }
        score += Math.min(criticalTouches * 2, 4);

        return Math.min(Math.max(score, 1), 10);
    }

    /**
     * Generates a rule-based summary when LLMs are completely unavailable.
     * @param {Object} commitData - Raw commit metadata
     * @returns {Object} Structured JSON insight matching LLM schema expectations
     */
    generate(commitData) {
        this.logger.info(`[RuleBasedSummarizer] Executing zero-LLM heuristic extraction for commit ${commitData.hash || 'unknown'}`);
        
        const message = commitData.message || '';
        const files = commitData.filesChanged || [];
        const additions = commitData.additions || 0;
        const deletions = commitData.deletions || 0;
        const totalChanges = additions + deletions;

        // Parse conventional commit
        const conventionalMatch = message.match(/^([a-z]+)(?:\(([^)]+)\))?!?: (.+)/i);
        const parsed = conventionalMatch ? {
            type: conventionalMatch[1].toLowerCase(),
            scope: conventionalMatch[2] || 'global',
            subject: conventionalMatch[3]
        } : null;

        const category = parsed && this.commitTypes[parsed.type] 
            ? this.commitTypes[parsed.type].category 
            : 'Uncategorized';

        const issues = this._extractIssueTags(message);
        const domains = this._analyzeDomains(files);
        const riskScore = this._calculateRiskScore(parsed, files, totalChanges);

        // Construct a synthetic summary
        let summaryText = parsed ? parsed.subject : message.split('\n')[0];
        if (summaryText.length > 100) summaryText = summaryText.substring(0, 97) + '...';

        const description = `Automated heuristic summary: This commit introduces changes classified as ${category}. ` +
            `It affects ${files.length} file(s) across domains like ${domains.join(', ')}. ` +
            `The total change volume is ${totalChanges} lines (${additions} additions, ${deletions} deletions). ` +
            (issues.length > 0 ? `It references issues: ${issues.join(', ')}.` : '');

        return {
            metadata: {
                hash: commitData.hash,
                author: commitData.author,
                timestamp: commitData.timestamp || new Date().toISOString(),
                generated_by: 'rule_based_fallback_engine_v3'
            },
            summary: {
                short_title: summaryText,
                detailed_description: description,
                category: category,
                primary_domains: domains
            },
            metrics: {
                files_changed: files.length,
                total_lines_changed: totalChanges,
                risk_assessment: {
                    score_1_to_10: riskScore,
                    level: riskScore >= 7 ? 'High' : riskScore >= 4 ? 'Medium' : 'Low'
                }
            },
            tags: [...domains, category, ...issues].map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '_'))
        };
    }
}

/**
 * Main Fallback Engine Orchestrator.
 * Manages the transition between execution levels when primary systems fail.
 */
class FallbackEngine extends EventEmitter {
    /**
     * @param {Object} llmClient - The primary LLM client interface
     * @param {Object} logger - Logging utility
     * @param {Object} [config] - Optional configuration overrides
     */
    constructor(llmClient, logger, config = {}) {
        super();
        this.llmClient = llmClient;
        this.logger = logger || console;
        this.config = { ...FALLBACK_CONSTANTS, ...config };
        this.ruleBasedSummarizer = new RuleBasedSummarizer(this.logger);
        
        this.metrics = {
            total_requests: 0,
            primary_success: 0,
            level_1_success: 0,
            level_2_success: 0,
            level_3_success: 0,
            total_failures: 0
        };
    }

    /**
     * Helper to pause execution for a given number of milliseconds.
     * @param {number} ms 
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Calculates exponential backoff with jitter.
     * @param {number} attempt - Current attempt number
     * @returns {number} Delay in milliseconds
     */
    _calculateBackoff(attempt) {
        const exponential = this.config.BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * 500; // 0-500ms jitter
        return Math.min(exponential + jitter, this.config.MAX_DELAY_MS);
    }

    /**
     * LEVEL 1: Standard Retry Mechanism
     * Executes the primary LLM call with exponential backoff and jitter.
     * @param {Object} commitData - The data to process
     * @param {string} originalPrompt - The full, complex prompt
     * @returns {Promise<Object>} The LLM response
     */
    async _attemptLevel1(commitData, originalPrompt) {
        let lastError;
        
        for (let attempt = 0; attempt <= this.config.MAX_RETRIES_LEVEL_1; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this._calculateBackoff(attempt);
                    this.logger.warn(`[FallbackEngine Level 1] Retry attempt ${attempt}/${this.config.MAX_RETRIES_LEVEL_1}. Waiting ${Math.round(delay)}ms...`);
                    await this._sleep(delay);
                }

                this.emit('execution_start', { level: attempt === 0 ? this.config.LEVELS.PRIMARY : this.config.LEVELS.LEVEL_1, attempt });
                
                // Set a timeout for the LLM call to prevent hanging
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.config.TIMEOUT_MS);

                const response = await this.llmClient.generateStructuredInsight({
                    commitData,
                    prompt: originalPrompt,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                
                if (!response || !response.summary) {
                    throw new Error("Invalid response schema from LLM");
                }

                if (attempt === 0) this.metrics.primary_success++;
                else this.metrics.level_1_success++;

                this.emit('execution_success', { level: attempt === 0 ? this.config.LEVELS.PRIMARY : this.config.LEVELS.LEVEL_1, attempt });
                return response;

            } catch (error) {
                lastError = error;
                this.logger.error(`[FallbackEngine Level 1] Attempt ${attempt} failed: ${error.message}`);
                
                // If it's an abort/timeout, or a 5xx error, we retry. If it's a 4xx (bad request), we should probably skip to Level 2 immediately.
                if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                    this.logger.warn(`[FallbackEngine Level 1] Client error ${error.status} detected. Bypassing further Level 1 retries.`);
                    break;
                }
            }
        }

        throw new FallbackError("Level 1 (Retry Backoff) exhausted.", this.config.LEVELS.LEVEL_1, lastError);
    }

    /**
     * LEVEL 2: Simplified Prompt
     * Strips away complex reasoning requests and asks for a bare-minimum JSON structure.
     * Useful when the LLM is struggling with context size or complex instruction following.
     * @param {Object} commitData - The data to process
     * @returns {Promise<Object>} The LLM response
     */
    async _attemptLevel2(commitData) {
        this.emit('execution_start', { level: this.config.LEVELS.LEVEL_2 });
        this.logger.warn(`[FallbackEngine Level 2] Engaging Degraded Mode: Simplified Prompt for commit ${commitData.hash}`);

        const simplifiedPrompt = `
            You are a fallback summarization system. The primary system failed.
            Analyze this git commit and return ONLY a valid JSON object. Do not include markdown formatting or explanations.
            
            COMMIT MESSAGE:
            ${commitData.message}
            
            FILES CHANGED:
            ${(commitData.filesChanged || []).slice(0, 10).join(', ')}
            
            REQUIRED JSON SCHEMA:
            {
                "summary": { "short_title": "string", "detailed_description": "string", "category": "string" },
                "metrics": { "files_changed": number, "risk_assessment": { "level": "Low|Medium|High" } },
                "tags": ["string"]
            }
        `;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.config.TIMEOUT_MS);

            // Use a highly robust, low-temperature setting for the fallback
            const response = await this.llmClient.generateStructuredInsight({
                commitData,
                prompt: simplifiedPrompt,
                temperature: 0.1, // Force deterministic output
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response || !response.summary) {
                throw new Error("Invalid response schema from Level 2 simplified prompt");
            }

            this.metrics.level_2_success++;
            this.emit('execution_success', { level: this.config.LEVELS.LEVEL_2 });
            
            // Tag the response to indicate it was generated in degraded mode
            response._metadata = { ...response._metadata, degraded_mode: true, fallback_level: 2 };
            return response;

        } catch (error) {
            this.logger.error(`[FallbackEngine Level 2] Simplified prompt execution failed: ${error.message}`);
            throw new FallbackError("Level 2 (Simplified Prompt) failed.", this.config.LEVELS.LEVEL_2, error);
        }
    }

    /**
     * LEVEL 3: Rule-Based Engine
     * Zero-LLM fallback. Uses pure heuristics to guarantee a payload is delivered.
     * @param {Object} commitData - The data to process
     * @returns {Object} Structured JSON
     */
    _attemptLevel3(commitData) {
        this.emit('execution_start', { level: this.config.LEVELS.LEVEL_3 });
        this.logger.error(`[FallbackEngine Level 3] CRITICAL: Engaging Zero-LLM Rule-Based Heuristics for commit ${commitData.hash}`);
        
        try {
            const result = this.ruleBasedSummarizer.generate(commitData);
            this.metrics.level_3_success++;
            this.emit('execution_success', { level: this.config.LEVELS.LEVEL_3 });
            
            result._metadata = { ...result._metadata, degraded_mode: true, fallback_level: 3, zero_llm: true };
            return result;
        } catch (error) {
            this.logger.error(`[FallbackEngine Level 3] Rule-based engine failed spectacularly: ${error.message}`);
            throw new FallbackError("Level 3 (Rule Based) failed. Total system collapse.", this.config.LEVELS.LEVEL_3, error);
        }
    }

    /**
     * Main entry point for the Fallback Engine.
     * Orchestrates the cascade from Primary -> Level 1 -> Level 2 -> Level 3.
     * 
     * @param {Object} commitData - Raw commit data payload
     * @param {string} originalPrompt - The ideal, complex LLM prompt
     * @returns {Promise<Object>} Guaranteed to return a structured insight object unless memory/CPU fails.
     */
    async execute(commitData, originalPrompt) {
        this.metrics.total_requests++;
        
        if (!commitData) {
            this.metrics.total_failures++;
            throw new Error("FallbackEngine: commitData is required for execution.");
        }

        try {
            // Attempt Level 1 (Includes the initial primary attempt + retries)
            return await this._attemptLevel1(commitData, originalPrompt);
        } catch (level1Error) {
            this.logger.warn(`[FallbackEngine] Level 1 bypassed. Transitioning to Level 2. Reason: ${level1Error.message}`);
            
            try {
                // Attempt Level 2 (Simplified LLM Prompt)
                return await this._attemptLevel2(commitData);
            } catch (level2Error) {
                this.logger.warn(`[FallbackEngine] Level 2 bypassed. Transitioning to Level 3. Reason: ${level2Error.message}`);
                
                try {
                    // Attempt Level 3 (Zero-LLM Rule-Based Extraction)
                    return this._attemptLevel3(commitData);
                } catch (level3Error) {
                    // If we reach here, something is fundamentally broken with the runtime or data payload.
                    this.metrics.total_failures++;
                    this.logger.error(`[FallbackEngine] TOTAL SYSTEM FAILURE. All fallback levels exhausted for commit ${commitData.hash}`);
                    
                    // Return an absolute baseline skeleton to prevent downstream pipeline crashes
                    return {
                        metadata: { hash: commitData.hash, error: "TOTAL_FALLBACK_FAILURE" },
                        summary: { short_title: "Commit Analysis Failed", detailed_description: "System was unable to process this commit at any fallback level.", category: "Unknown" },
                        metrics: { files_changed: (commitData.filesChanged || []).length, risk_assessment: { level: "High" } },
                        tags: ["error", "unprocessed"]
                    };
                }
            }
        }
    }

    /**
     * Retrieves current health and execution metrics for the fallback engine.
     * @returns {Object} Metrics payload
     */
    getMetrics() {
        return {
            ...this.metrics,
            success_rate: this.metrics.total_requests > 0 
                ? ((this.metrics.total_requests - this.metrics.total_failures) / this.metrics.total_requests) * 100 
                : 100,
            degradation_rate: this.metrics.total_requests > 0
                ? ((this.metrics.level_2_success + this.metrics.level_3_success) / this.metrics.total_requests) * 100
                : 0,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = {
    FallbackEngine,
    RuleBasedSummarizer,
    FallbackError,
    FALLBACK_CONSTANTS
};