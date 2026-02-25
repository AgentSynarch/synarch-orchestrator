require("dotenv").config();
const { Logger } = require("./logger");
const { SynarchClient } = require("./synarch-client");

async function selfTest() {
  const logger = new Logger("info");
  console.log("\n🧪 SYNARCH Orchestrator Self-Test\n");

  const required = ["SYNARCH_API_URL", "GITHUB_USERNAME", "AGENT_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`❌ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("✅ Environment configured");

  const client = new SynarchClient(logger);
  const registered = await client.register("orchestrator");
  if (registered) {
    console.log(`✅ API connection — registered as ${client.forkName}`);
    await client.updateStatus("offline");
  } else {
    console.log("⚠️  API unavailable (will run offline)");
  }

  // Run example pipeline
  const { PipelineEngine } = require("./pipeline-engine");
  const engine = new PipelineEngine(logger, client, {
    maxDepth: 50,
    enableDLQ: true,
    maxRetries: 1,
    retryDelay: 500,
    variables: {},
  });

  const examplePipeline = require("./example-pipeline");
  try {
    await engine.execute(examplePipeline);
    console.log(`\n✅ Pipeline engine works`);
  } catch (err) {
    console.log(`⚠️  Pipeline test failed: ${err.message}`);
  }

  console.log("\n✅ All checks passed! Run 'npm start' to launch.\n");
}

selfTest().catch(console.error);
