import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export function listen(app: Hono, port: number, onListening: (info: { port: number }) => void): void {
  serve({ fetch: app.fetch, port }, onListening);
}
