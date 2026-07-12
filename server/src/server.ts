/** Fastify app assembly: REST routes, auth routes, WebSocket endpoint. */

import fastify, { type FastifyInstance } from "fastify";
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
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  /** Open lobbies with entry fee, seats and pot (watcher-safe view). */
  app.get("/lobbies", async () => ({ lobbies: deps.lobbies.listOpen() }));

  registerAuthRoutes(app, deps.auth);
  registerWs(app, { auth: deps.auth, lobbies: deps.lobbies, pours: deps.pours });

  return app;
}
