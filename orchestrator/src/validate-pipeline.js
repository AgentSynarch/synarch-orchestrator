const fs = require("fs");

function validatePipeline(filePath) {
  console.log(`\n🔍 Validating pipeline: ${filePath}\n`);

  let pipeline;
  try {
    pipeline = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.log(`❌ Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  const errors = [];
  const warnings = [];

  if (!pipeline.name) errors.push("Missing 'name' field");
  if (!pipeline.steps || !Array.isArray(pipeline.steps)) {
    errors.push("Missing or invalid 'steps' array");
  } else {
    const ids = new Set();
    const validTypes = [
      "http-source", "http-sink", "transform", "filter", "map", "reduce",
      "flatten", "delay", "log", "set-var", "file-read", "file-write",
      "assert", "parallel", "branch",
    ];

    pipeline.steps.forEach((step, i) => {
      if (!step.id) errors.push(`Step ${i}: missing 'id'`);
      if (!step.type) errors.push(`Step ${i}: missing 'type'`);
      if (step.id && ids.has(step.id)) errors.push(`Step ${i}: duplicate id '${step.id}'`);
      if (step.id) ids.add(step.id);
      if (step.type && !validTypes.includes(step.type)) warnings.push(`Step ${i} (${step.id}): unknown type '${step.type}'`);
      if (step.type === "http-source" && !step.config?.url) errors.push(`Step ${i} (${step.id}): http-source requires config.url`);
      if (step.type === "transform" && !step.config?.script) errors.push(`Step ${i} (${step.id}): transform requires config.script`);
      if (step.type === "parallel" && !step.branches) errors.push(`Step ${i} (${step.id}): parallel requires 'branches' array`);
      if (step.type === "branch" && !step.cases) errors.push(`Step ${i} (${step.id}): branch requires 'cases' array`);
    });
  }

  if (errors.length > 0) {
    console.log("❌ Errors:");
    errors.forEach((e) => console.log(`   • ${e}`));
  }
  if (warnings.length > 0) {
    console.log("⚠️  Warnings:");
    warnings.forEach((w) => console.log(`   • ${w}`));
  }
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`✅ Pipeline "${pipeline.name}" is valid (${pipeline.steps.length} steps)`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

const file = process.argv[2] || "./pipelines/default.json";
validatePipeline(file);
