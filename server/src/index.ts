/** Bootstrap: config, chain client, persistence, lobby manager, HTTP/WS server. */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { AuthService } from "./auth.js";
import { AnchorChainClient } from "./chain/anchorClient.js";
import { MockChainClient, type ChainClient } from "./chain/client.js";
import { loadConfig } from "./config.js";
import { LobbyManager } from "./game/lobby.js";
import { PourSessionManager } from "./game/pourSession.js";
import { JsonStore } from "./persistence.js";
import { buildApp } from "./server.js";
import type { NonceStoreData } from "./auth.js";
import type { LobbyStoreData } from "./types.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  await mkdir(cfg.dataDir, { recursive: true });

  const chain: ChainClient =
    cfg.chain === "anchor"
      ? new AnchorChainClient({
          rpcUrl: cfg.rpcUrl,
          programId: cfg.programId,
          resultAuthority: cfg.resultAuthority,
          treasury: cfg.treasury as PublicKey,
          oracleQueue: cfg.oracleQueue,
        })
      : new MockChainClient();

  const store = new JsonStore<LobbyStoreData>(path.join(cfg.dataDir, "lobbies.json"));
  const nonceStore = new JsonStore<NonceStoreData>(path.join(cfg.dataDir, "nonces.json"));
  const lobbies = new LobbyManager({ chain, store, lobbySize: cfg.lobbySize });
  const pours = new PourSessionManager(lobbies);
  const auth = new AuthService(cfg.authSecret, undefined, undefined, nonceStore);

  await auth.init();
  await lobbies.init();

  // Keep at least one open lobby available at all times.
  const ensureOpenLobby = async (): Promise<void> => {
    if (lobbies.listOpen().length === 0) {
      const lobby = await lobbies.createLobby(cfg.defaultEntryFeeLamports);
      console.log(`created lobby ${lobby.lobbyId} (entry ${cfg.defaultEntryFeeLamports} lamports)`);
    }
  };
  lobbies.onSettled(() => {
    void ensureOpenLobby().catch((err) => console.error("ensureOpenLobby failed", err));
  });
  await ensureOpenLobby();

  const app = await buildApp({ auth, lobbies, pours, chainMode: cfg.chain });
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`ZAPF ROYALE server on :${cfg.port} (chain=${cfg.chain})`);

  // Housekeeping: cancel expired lobbies, prune login nonces.
  const sweep = setInterval(() => {
    void lobbies.sweepExpired().catch((err) => console.error("sweepExpired failed", err));
    auth.pruneNonces();
  }, 10 * 60_000);
  sweep.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep);
    lobbies.dispose();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
