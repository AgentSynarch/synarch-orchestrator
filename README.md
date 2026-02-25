# Synarch Orchestrator

Data pipeline agent for the Synarch network. Manages ETL flows, event routing, data transformation, and parallel processing through JSON-driven pipeline definitions.

## Quick Start

```sh
git clone https://github.com/AgentSynarch/synarch-orchestrator.git
cd synarch-orchestrator
npm install
echo "AGENT_TOKEN=<your-token>" > .env
npm start
```

Get your `AGENT_TOKEN` from the [Synarch launch page](https://synarch.io/launch) by clicking the Orchestrator card.

## What It Does

The orchestrator agent executes data pipelines defined as JSON configurations. Built-in capabilities include:

- **Pipeline Execution** — runs multi-step data flows with branching and parallelism
- **Data Transformation** — maps, filters, and aggregates data between steps
- **Event Routing** — directs data to different outputs based on conditions
- **Pipeline Validation** — checks pipeline definitions for errors before execution

## Project Structure

```
src/
  index.js             — entry point, connects to Synarch network
  synarch-client.js    — handles registration and heartbeats
  pipeline-engine.js   — core pipeline execution logic
  validate-pipeline.js — validates pipeline JSON definitions
  example-pipeline.js  — sample pipeline for reference
  logger.js            — structured logging
  self-test.js         — built-in connectivity test
pipelines/
  default.json         — default pipeline configuration
  advanced-example.json — complex pipeline with branching
```

## Configuration

All configuration is done via the `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_TOKEN` | Yes | Unique token from Synarch launch page |

## Pipeline Format

Pipelines are defined as JSON files in the `pipelines/` directory:

```json
{
  "name": "my-pipeline",
  "steps": [
    {
      "id": "fetch",
      "type": "http",
      "config": {
        "url": "https://api.example.com/data",
        "method": "GET"
      }
    },
    {
      "id": "transform",
      "type": "map",
      "input": "fetch",
      "config": {
        "fields": ["id", "name", "value"]
      }
    },
    {
      "id": "output",
      "type": "webhook",
      "input": "transform",
      "config": {
        "url": "https://your-endpoint.com/receive"
      }
    }
  ]
}
```

## How It Connects

On startup, the agent:

1. Reads `AGENT_TOKEN` from `.env`
2. Sends a registration heartbeat to the Synarch network
3. Status changes from `pending` to `active` in the live registry
4. Loads and validates pipeline definitions from `pipelines/`
5. Begins executing pipelines on schedule or trigger
6. Sends periodic heartbeats and log data

## License

MIT
