/** Fastify app assembly: REST routes, auth routes, WebSocket endpoint. */

import fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerAuthRoutes, type AuthService } from "./auth.js";
import type { LobbyManager } from "./game/lobby.js";
import type { PourSessionManager } from "./game/pourSession.js";
import { registerWs } from "./ws.js";

export interface AppDeps {
  auth: AuthService;
  lobbies: LobbyManager;
  pours: PourSessionManager;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = fastify({ logger: deps.logger ?? true });
  // Web-Frontend läuft auf einer anderen Domain (eigener Railway-Service) —
  // ohne CORS blockt der Browser alle REST-Calls. Optional per CORS_ORIGIN
  // auf eine konkrete Origin einschränken; Default: alle (devnet/Testphase).
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.trim() || true,
  });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  /** Open lobbies with entry fee, seats and pot (watcher-safe view). */
  app.get("/lobbies", async () => ({ lobbies: deps.lobbies.listOpen() }));

  registerAuthRoutes(app, deps.auth);
  registerWs(app, { auth: deps.auth, lobbies: deps.lobbies, pours: deps.pours });

  return app;
}
