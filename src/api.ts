import express from "express";
import { sdk, langfuseSpanProcessor } from "./instrumentation";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk/error.js";
import {
  getActiveSpanId,
  getActiveTraceId,
  startActiveObservation,
  type LangfuseGenerationAttributes,
} from "@langfuse/tracing";
import { VERSION } from "./version";
import { MessagesAPIRequest, MODEL_COSTS } from "./types";
import { PrefixedLogger } from "./logger";

export const app = express();
const defaultPort = 5678;
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(express.json({ limit: "100mb" }));

app.post("/v1/messages", async (req, res) => {
  const auth = req.headers.authorization;
  const xauth = req.header("x-api-key");
  const logger = new PrefixedLogger("[/v1/messages]");
  if (!auth && !xauth) {
    logger.error("No Authorization header and no x-api-key found");
    res.status(401).send({ detail: "Unauthorized" });
    return;
  }
  if (!xauth && auth && !auth.startsWith("Bearer ")) {
    logger.error(
      "Authorization header has no bearer and x-api-key not available",
    );
    res.status(401).send({ detail: "Unauthorized" });
    return;
  }
  let apiKey: string;
  if (auth) {
    logger.authMethod = "Authorization";
    apiKey = auth.replace("Bearer ", "");
  } else {
    logger.authMethod = "x-api-key";
    apiKey = xauth!;
  }
  if (apiKey != process.env.INTERNAL_API_KEY) {
    logger.error("Auth failed: API key does not match");
    res.status(401).send({ detail: "Unauthorized" });
    return;
  }
  const observeAnthropic = async () => {
    await startActiveObservation("request", async (span) => {
      let generation;
      const traceId = getActiveTraceId() ?? "anonymous-trace";
      const spanId = getActiveSpanId() ?? "anonymous-span";
      logger.spanId = spanId;
      logger.traceId = traceId;
      try {
        const validated = await MessagesAPIRequest.parseAsync(req.body);
        const userInput = validated.messages.at(validated.messages.length - 1)!;
        logger.silly("Validated messages");
        logger.model = validated.model;
        span.update({ input: { query: userInput.content } });
        generation = span.startObservation(
          "llm-call",
          {
            model: validated.model,
            input: validated.messages,
            metadata: {
              cache_control: validated.cache_control,
              tools: validated.tools,
              tool_choice: validated.tool_choice,
              user_id: validated.metadata.user_id,
              stream: validated.stream,
              max_output_tokens: validated.max_tokens,
              thinking: validated.thinking,
              system: validated.system,
            },
            completionStartTime: new Date(),
            environment: process.env.DEPLOYMENT_ENVIRONMENT,
            version: VERSION,
          } as unknown as LangfuseGenerationAttributes,
          { asType: "generation" },
        );
        logger.silly("Updated span and created child generation");
        if (!validated.stream) {
          logger.debug("No streaming response");
          const response = await anthropic.messages.create(req.body);
          logger.info("Generated response");
          const modelCosts = MODEL_COSTS[validated.model] ?? {
            baseInput: 0,
            output: 0,
            cacheHitsRefreshes: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
          };
          generation
            .update({
              output: response.content,
              usageDetails: {
                cacheCreationInputTokens:
                  response.usage.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens:
                  response.usage.cache_read_input_tokens ?? 0,
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens:
                  response.usage.input_tokens +
                  (response.usage.cache_read_input_tokens ?? 0) +
                  response.usage.output_tokens,
              },
              costDetails: {
                inputCost:
                  (response.usage.input_tokens ?? 0 / 1_000_000) *
                  modelCosts.baseInput,
                cacheCreationCost:
                  (response.usage.cache_creation_input_tokens ??
                    0 / 1_000_000) *
                  ((validated.cache_control?.ttl ?? "5m") === "5m"
                    ? modelCosts.cacheWrite5m
                    : modelCosts.cacheWrite1h),
                cacheHitsCost:
                  (response.usage.cache_read_input_tokens ?? 0 / 1_000_000) *
                  modelCosts.cacheHitsRefreshes,
                outputCost:
                  (response.usage.output_tokens / 1_000_000) *
                  modelCosts.output,
              },
              model: response.model,
              metadata: {
                id: response.id,
                request_id: response._request_id,
                stop_reason: response.stop_reason,
              },
            })
            .end();
          span.update({ output: "SUCCESS" }).end();
          logger.silly(
            "Ended span and child generation, sending 200 response.",
          );
          res
            .status(200)
            .setHeader("Content-Type", "application/json")
            .send(response);
          return;
        } else {
          logger.debug("Streaming response");
          // Set SSE headers before any data flows
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders(); // flush immediately so the client knows streaming started
          logger.silly("Flushed response header");

          const stream = anthropic.messages.stream(req.body);
          logger.silly("Started streaming");
          let currentOutputToks = 0;
          const modelCosts = MODEL_COSTS[validated.model] ?? {
            baseInput: 0,
            output: 0,
            cacheHitsRefreshes: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
          };

          for await (const event of stream) {
            logger.silly(`Received event of type ${event.type}`);
            res.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            if (event.type === "message_delta") {
              generation.update({
                output: event.delta,
                usageDetails: {
                  input: event.usage.input_tokens ?? 0,
                  output: event.usage.output_tokens - currentOutputToks,
                  input_cached_tokens: event.usage.cache_read_input_tokens ?? 0,
                  input_cache_creation:
                    event.usage.cache_creation_input_tokens ?? 0,
                  total:
                    (event.usage.input_tokens ?? 0) +
                    (event.usage.cache_read_input_tokens ?? 0) +
                    (event.usage.output_tokens - currentOutputToks),
                },
                costDetails: {
                  input:
                    ((event.usage.input_tokens ?? 0) / 1_000_000) *
                    modelCosts.baseInput,
                  input_cache_creation:
                    ((event.usage.cache_creation_input_tokens ?? 0) /
                      1_000_000) *
                    ((validated.cache_control?.ttl ?? "5m") === "5m"
                      ? modelCosts.cacheWrite5m
                      : modelCosts.cacheWrite1h),
                  input_cached_tokens:
                    ((event.usage.cache_read_input_tokens ?? 0) / 1_000_000) *
                    modelCosts.cacheHitsRefreshes,
                  output:
                    ((event.usage.output_tokens - currentOutputToks) /
                      1_000_000) *
                    modelCosts.output,
                },
              });
              currentOutputToks = event.usage.output_tokens;
              logger.silly("Updated generation with event data");
            }
          }
          generation.end();
          span.update({ output: "SUCCESS" }).end();
          logger.info("Generated response");
          res.end();
        }
      } catch (e) {
        logger.error(
          e instanceof AnthropicError ? e.message : `An error occurred: ${e}`,
        );
        if (generation) {
          generation
            .update({
              output: "ERROR",
              statusMessage:
                e instanceof AnthropicError
                  ? e.message
                  : `An error occurred: ${e}`,
            })
            .end();
          logger.debug("Updated generation with error details");
        }
        span
          .update({
            output: "ERROR",
            statusMessage:
              e instanceof AnthropicError
                ? e.message
                : `An error occurred: ${e}`,
          })
          .end();
        logger.debug("Updated span with error details");
        if (!res.headersSent) {
          logger.silly("Sending 500 response for non-streaming request");
          res.status(500).json({
            detail:
              e instanceof AnthropicError
                ? e.message
                : `An error occurred: ${e}`,
          });
        } else {
          logger.silly("Streaming error for streaming request");
          const errEvent = {
            type: "error",
            error: {
              type: "api_error",
              message:
                e instanceof AnthropicError
                  ? e.message
                  : `An error occurred: ${e}`,
            },
          };
          res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`);
          res.end();
        }
      } finally {
        logger.silly("Flushing Langfuse SpanProcessor");
        await langfuseSpanProcessor.forceFlush();
      }
    });
  };
  await observeAnthropic();
});

export async function runServer(port?: number | undefined) {
  app.listen(port ?? defaultPort, () => {
    console.log(`App listening on port ${port ?? defaultPort}`);
  });

  const logger = new PrefixedLogger("[runServer]");

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    try {
      await langfuseSpanProcessor.forceFlush();
      await sdk.shutdown();
    } catch (e) {
      logger.error(`Error during shutdown: ${e}`);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
