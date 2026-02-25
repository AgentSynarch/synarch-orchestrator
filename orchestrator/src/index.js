require("dotenv").config();
const { Logger } = require("./logger");
const { SynarchClient } = require("./synarch-client");
const { PipelineEngine } = require("./pipeline-engine");
const fs = require("fs");

const logger = new Logger(process.env.LOG_LEVEL || "info");
const client = new SynarchClient(logger);

async function main() {
  const banner = `
  ╔═══════════════════════════════════════╗
  ║   SYNARCH ORCHESTRATOR AGENT v2.0.0  ║
  ║   Advanced data pipeline engine      ║
  ╚═══════════════════════════════════════╝`;
  console.log(banner);

  logger.info(`Agent: ${process.env.AGENT_NAME || "unnamed"}`);

  const registered = await client.register("orchestrator");
  if (!registered) {
    logger.warn("Running in offline mode (API unavailable)");
  } else {
    logger.info("Connected to Synarch network ✓");
  }

  client.startHeartbeat();

  // Load pipeline
  const pipelineFile = process.env.PIPELINE_FILE || "./pipelines/default.json";
  let pipelineDef;
  try {
    pipelineDef = JSON.parse(fs.readFileSync(pipelineFile, "utf-8"));
    logger.info(`Loaded pipeline: "${pipelineDef.name}" (${pipelineDef.steps.length} steps)`);
  } catch (err) {
    logger.error(`Failed to load pipeline from ${pipelineFile}: ${err.message}`);
    logger.info("Using built-in example pipeline");
    pipelineDef = require("./example-pipeline");
  }

  const engine = new PipelineEngine(logger, client, {
    maxDepth: parseInt(process.env.MAX_PIPELINE_DEPTH || "50"),
    enableDLQ: process.env.ENABLE_DLQ !== "false",
    pollInterval: parseInt(process.env.POLL_INTERVAL || "10000"),
    maxRetries: parseInt(process.env.MAX_RETRIES || "3"),
    retryDelay: parseInt(process.env.RETRY_DELAY || "1000"),
    variables: loadVariables(),
  });

  // Run pipeline
  const result = await engine.execute(pipelineDef);

  if (engine.dlq.length > 0) {
    logger.warn(`Dead letter queue: ${engine.dlq.length} failed events`);
    // Persist DLQ to disk
    const dlqFile = `./dlq-${Date.now()}.json`;
    fs.writeFileSync(dlqFile, JSON.stringify(engine.dlq, null, 2));
    logger.info(`DLQ saved to ${dlqFile}`);
  }

  // Polling mode
  if (process.env.AUTO_RESTART === "true") {
    const interval = parseInt(process.env.POLL_INTERVAL || "10000");
    logger.info(`\nPolling mode active — re-running every ${interval / 1000}s`);
    setInterval(async () => {
      logger.info("\n── Pipeline re-run ──");
      await engine.execute(pipelineDef);
    }, interval);
  } else {
    await client.updateStatus("idle");
    process.exit(0);
  }

  const shutdown = async (signal) => {
    logger.info(`\nReceived ${signal}. Shutting down...`);
    if (engine.dlq.length > 0) {
      fs.writeFileSync(`./dlq-shutdown-${Date.now()}.json`, JSON.stringify(engine.dlq, null, 2));
      logger.info("DLQ persisted to disk");
    }
    await client.updateStatus("offline");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function loadVariables() {
  const vars = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("PIPELINE_VAR_")) {
      vars[key.replace("PIPELINE_VAR_", "").toLowerCase()] = val;
    }
  }
  return vars;
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
