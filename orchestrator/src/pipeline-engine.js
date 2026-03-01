const axios = require("axios");
const fs = require("fs");
const path = require("path");

class PipelineEngine {
  constructor(logger, client, options = {}) {
    this.logger = logger;
    this.client = client;
    this.maxDepth = options.maxDepth || 70;
    this.enableDLQ = options.enableDLQ !== false;
    this.maxRetries = options.maxRetries || 5;
    this.retryDelay = options.retryDelay || 3000;
    this.variables = options.variables || {};
    this.dlq = [];
    this.stepMetrics = {};
  }

  async execute(pipeline) {
    this.logger.info(`\n▶ Pipeline: "${pipeline.name}"`);
    const startTime = Date.now();
    let data = pipeline.initialData || null;

    for (let i = 0; i < pipeline.steps.length; i++) {
      if (i >= this.maxDepth) {
        this.logger.error(`Circuit break at step ${i} (max depth: ${this.maxDepth})`);
        break;
      }

      const step = pipeline.steps[i];

      // Conditional execution
      if (step.condition) {
        const shouldRun = this._evaluateCondition(step.condition, data);
        if (!shouldRun) {
          this.logger.info(`  ⏭ Skipping: ${step.id} (condition not met)`);
          continue;
        }
      }

      // Parallel steps
      if (step.type === "parallel") {
        data = await this._executeParallel(step, data, i, pipeline.steps.length);
        continue;
      }

      // Branch step
      if (step.type === "branch") {
        data = await this._executeBranch(step, data);
        continue;
      }

      // Regular step with retry
      data = await this._executeStepWithRetry(step, data, i, pipeline.steps.length);
      if (data === null && step.config?.stopOnNull) break;
    }

    const duration = Date.now() - startTime;
    this.logger.info(`\n✓ Pipeline "${pipeline.name}" complete (${duration}ms)`);

    if (this.client.agentId) {
      await this.client.reportLog("info", `Pipeline complete: ${pipeline.name}`, {
        duration,
        dlqSize: this.dlq.length,
        metrics: this.stepMetrics,
      });
    }

    return data;
  }

  async _executeStepWithRetry(step, inputData, index, total) {
    for (let attempt = 1; attempt <= (step.retries || this.maxRetries) + 1; attempt++) {
      const stepStart = Date.now();
      try {
        this.logger.info(`  [${index + 1}/${total}] ${step.type}: ${step.id}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}`);
        const result = await this._executeStep(step, inputData);
        const duration = Date.now() - stepStart;

        this.stepMetrics[step.id] = { status: "success", duration, attempts: attempt };
        return result;
      } catch (err) {
        const duration = Date.now() - stepStart;

        if (attempt <= (step.retries || this.maxRetries)) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          this.logger.warn(`  ✗ ${step.id} failed (attempt ${attempt}): ${err.message} — retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        this.stepMetrics[step.id] = { status: "failed", duration, error: err.message, attempts: attempt };
        this.logger.error(`  ✗ ${step.id} failed permanently: ${err.message}`);

        if (this.enableDLQ) {
          this.dlq.push({
            step: step.id,
            type: step.type,
            error: err.message,
            inputData,
            timestamp: new Date().toISOString(),
            attempts: attempt,
          });
        }

        // Check if we should continue or halt
        if (step.config?.continueOnError) {
          this.logger.warn(`  → Continuing pipeline (continueOnError: true)`);
          return inputData;
        }

        if (step.fallback) {
          this.logger.info(`  → Running fallback for ${step.id}`);
          try {
            return await this._executeStep(step.fallback, inputData);
          } catch (fbErr) {
            this.logger.error(`  → Fallback also failed: ${fbErr.message}`);
          }
        }

        throw err;
      }
    }
  }

  async _executeParallel(step, inputData, index, total) {
    this.logger.info(`  [${index + 1}/${total}] parallel: ${step.id} (${step.branches.length} branches)`);

    const results = await Promise.allSettled(
      step.branches.map(async (branch) => {
        let data = inputData;
        for (const subStep of branch.steps) {
          data = await this._executeStep(subStep, data);
        }
        return { name: branch.name, data };
      })
    );

    const output = {};
    for (const r of results) {
      if (r.status === "fulfilled") {
        output[r.value.name] = r.value.data;
        this.logger.info(`    ✓ Branch "${r.value.name}" completed`);
      } else {
        this.logger.error(`    ✗ Branch failed: ${r.reason?.message}`);
        if (this.enableDLQ) {
          this.dlq.push({ step: step.id, error: r.reason?.message, timestamp: new Date().toISOString() });
        }
      }
    }

    // Merge strategy
    if (step.merge === "array") return Object.values(output);
    if (step.merge === "first") return Object.values(output)[0];
    return output; // default: object keyed by branch name
  }

  async _executeBranch(step, inputData) {
    this.logger.info(`  branch: ${step.id} — evaluating ${step.cases.length} cases`);

    for (const c of step.cases) {
      const match = this._evaluateCondition(c.condition, inputData);
      if (match) {
        this.logger.info(`    → Matched case: "${c.name}"`);
        let data = inputData;
        for (const subStep of c.steps) {
          data = await this._executeStep(subStep, data);
        }
        return data;
      }
    }

    // Default case
    if (step.default) {
      this.logger.info(`    → Using default case`);
      let data = inputData;
      for (const subStep of step.default) {
        data = await this._executeStep(subStep, data);
      }
      return data;
    }

    this.logger.warn(`    → No matching case, passing data through`);
    return inputData;
  }

  _evaluateCondition(condition, data) {
    try {
      const fn = new Function("data", "vars", `return (${condition})`);
      return !!fn(data, this.variables);
    } catch {
      return true;
    }
  }

  _interpolateVariables(str) {
    if (typeof str !== "string") return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => this.variables[key] || `{{${key}}}`);
  }

  async _executeStep(step, inputData) {
    switch (step.type) {
      case "http-source": {
        const url = this._interpolateVariables(step.config.url);
        const method = step.config.method || "GET";
        const headers = step.config.headers || {};
        const body = step.config.body;
        const res = await axios({ method, url, headers, data: body, timeout: step.config.timeout || 15000 });
        this.logger.info(`    ← ${res.status} ${url}`);
        return res.data;
      }

      case "http-sink": {
        const url = this._interpolateVariables(step.config.url);
        const method = step.config.method || "POST";
        const headers = step.config.headers || {};
        const res = await axios({ method, url, headers, data: inputData, timeout: step.config.timeout || 15000 });
        this.logger.info(`    → ${res.status} ${url}`);
        return inputData;
      }

      case "transform": {
        const fn = new Function("data", "vars", `return (${step.config.script})(data, vars)`);
        return fn(inputData, this.variables);
      }

      case "filter": {
        const fn = new Function("data", "vars", `return (${step.config.predicate})(data, vars)`);
        if (!fn(inputData, this.variables)) {
          this.logger.info(`    ⏭ Filtered out`);
          return null;
        }
        return inputData;
      }

      case "map": {
        if (!Array.isArray(inputData)) {
          this.logger.warn(`    map: input is not an array, wrapping`);
          inputData = [inputData];
        }
        const fn = new Function("item", "vars", `return (${step.config.script})(item, vars)`);
        return inputData.map((item) => fn(item, this.variables));
      }

      case "reduce": {
        if (!Array.isArray(inputData)) return inputData;
        const fn = new Function("acc", "item", "vars", `return (${step.config.script})(acc, item, vars)`);
        const initial = step.config.initial !== undefined ? step.config.initial : {};
        return inputData.reduce((acc, item) => fn(acc, item, this.variables), initial);
      }

      case "flatten": {
        if (!Array.isArray(inputData)) return inputData;
        const depth = step.config?.depth || 1;
        return inputData.flat(depth);
      }

      case "delay": {
        const ms = step.config.ms || 1000;
        this.logger.info(`    ⏳ ${ms}ms`);
        await new Promise((r) => setTimeout(r, ms));
        return inputData;
      }

      case "log": {
        const preview = JSON.stringify(inputData, null, 2);
        const truncated = preview.length > 500 ? preview.substring(0, 500) + "\n    ..." : preview;
        this.logger.info(`    📋 Data:\n${truncated}`);
        return inputData;
      }

      case "set-var": {
        this.variables[step.config.name] = typeof step.config.value === "function"
          ? step.config.value(inputData)
          : step.config.value || inputData;
        this.logger.info(`    📌 Variable "${step.config.name}" set`);
        return inputData;
      }

      case "file-read": {
        const filePath = this._interpolateVariables(step.config.path);
        const content = fs.readFileSync(filePath, "utf-8");
        return step.config.json ? JSON.parse(content) : content;
      }

      case "file-write": {
        const filePath = this._interpolateVariables(step.config.path);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const output = typeof inputData === "string" ? inputData : JSON.stringify(inputData, null, 2);
        fs.writeFileSync(filePath, output);
        this.logger.info(`    💾 Written to ${filePath}`);
        return inputData;
      }

      case "assert": {
        const fn = new Function("data", `return (${step.config.test})(data)`);
        const pass = fn(inputData);
        if (!pass) {
          throw new Error(step.config.message || `Assertion failed at step ${step.id}`);
        }
        this.logger.info(`    ✓ Assertion passed`);
        return inputData;
      }

      default:
        this.logger.warn(`    Unknown step type: ${step.type}`);
        return inputData;
    }
  }
}

module.exports = { PipelineEngine };
