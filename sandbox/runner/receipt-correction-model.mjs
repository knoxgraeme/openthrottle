#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CORRECTION_MODEL = "gpt-5.1-code";
const REQUEST_TIMEOUT_MS = 60_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function codexAuthFromEnvironment() {
  if (process.env.CODEX_AUTH_JSON) return parseJson(process.env.CODEX_AUTH_JSON);
  if (!process.env.CODEX_HOME) return null;
  const path = join(process.env.CODEX_HOME, "auth.json");
  if (!existsSync(path)) return null;
  return parseJson(readFileSync(path, "utf8"));
}

function openAiApiKey(auth) {
  return process.env.OPENAI_API_KEY || (typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : null);
}

function codexAccessToken(auth) {
  const token = auth?.tokens?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function responseBody({ prompt, model }) {
  return {
    model: model || process.env.OT_RECEIPT_CORRECTION_MODEL || DEFAULT_CORRECTION_MODEL,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    tools: [],
    tool_choice: "none",
    text: {
      format: {
        type: "json_schema",
        name: "openthrottle_receipt_correction",
        schema: { type: "object", additionalProperties: true },
        strict: false,
      },
    },
    stream: false,
  };
}

async function fetchJson(url, { bearer, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model request failed with status ${response.status}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`model request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    if (error instanceof Error && /^model request failed with status [0-9]+$/.test(error.message)) throw error;
    throw new Error("model request failed");
  } finally {
    clearTimeout(timer);
  }
}

function textFromResponse(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  if (Array.isArray(response?.output)) {
    const parts = [];
    for (const item of response.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === "string") parts.push(content.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  const messageContent = response?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") return messageContent;
  throw new Error("model response did not contain text");
}

async function main() {
  const prompt = readStdin();
  const model = argValue("--model");
  const auth = codexAuthFromEnvironment();
  const apiKey = openAiApiKey(auth);
  const accessToken = codexAccessToken(auth);
  const body = responseBody({ prompt, model });
  const response = apiKey
    ? await fetchJson("https://api.openai.com/v1/responses", { bearer: apiKey, body })
    : accessToken
      ? await fetchJson("https://chatgpt.com/backend-api/codex/responses", { bearer: accessToken, body })
      : (() => { throw new Error("missing model credential for receipt correction"); })();
  process.stdout.write(textFromResponse(response).trim());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "receipt correction failed"}\n`);
  process.exit(1);
});
