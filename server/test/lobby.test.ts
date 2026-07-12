import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockChainClient } from "../src/chain/client.js";
import { OVERFLOW_SENTINEL } from "../src/game/constants.js";
import { LobbyManager } from "../src/game/lobby.js";
import { JsonStore } from "../src/persistence.js";
import type { LobbyStoreData } from "../src/types.js";

const ENTRY_FEE = 100_000_000n; // 0.1 SOL
const W = ["walletA", "walletB", "walletC", "walletD", "walletE"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LobbyManager", () => {
  let dir: string;
  let chain: MockChainClient;
  let manager: LobbyManager;

  const makeManager = (playTimeoutMs: number, c = chain): LobbyManager =>
    new LobbyManager({
      chain: c,
      store: new JsonStore<LobbyStoreData>(path.join(dir, "lobbies.json")),
      lobbySize: 5,
      playTimeoutMs,
      log: () => undefined,
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zapf-lobby-"));
    chain = new MockChainClient();
  });

  afterEach(async () => {
    manager?.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a lobby via VRF request: awaiting_randomness -> open with fulfilled round", async () => {
    manager = makeManager(60_000);
    await manager.init();
    const statuses: string[] = [];
    manager.onUpdate((l) => statuses.push(l.status));

    const lobby = await manager.createLobby(ENTRY_FEE);
    expect(chain.createLobbyCalls).toHaveLength(1);
    expect(chain.createLobbyCalls[0]!.clientSeedHex).toBe(lobby.clientSeedHex);
    expect(statuses).toEqual(["awaiting_randomness", "open"]);
    expect(lobby.status).toBe("open");
    expect(lobby.randomnessHex).toHaveLength(64);
    expect([500, 1000, 1500]).toContain(lobby.targetMl);
    expect(lobby.pressureMilli).toBeGreaterThanOrEqual(800);
    expect(lobby.pressureMilli).toBeLessThanOrEqual(1300);
    // watcher view never leaks target/pressure/randomness before settlement
    const pub = manager.publicState(lobby);
    expect(JSON.stringify(pub)).not.toContain(lobby.randomnessHex);
    expect(pub.randomnessHex).toBeNull();
  });

  it("holds joins while awaiting randomness and opens once fulfilled", async () => {
    manager = makeManager(60_000);
    await manager.init();
    chain.autoFulfill = false;

    const created = manager.createLobby(ENTRY_FEE);
    await sleep(20); // create_lobby tx sent, oracle callback still pending
    const lobbyId = chain.createLobbyCalls[0]!.lobbyId;
    expect(manager.getLobby(lobbyId)!.status).toBe("awaiting_randomness");
    await expect(manager.confirmJoin(lobbyId, W[0]!, "sig-1")).rejects.toMatchObject({
      code: "LOBBY_CLOSED",
    });

    chain.fulfill(lobbyId); // oracle callback lands
    const lobby = await created;
    expect(lobby.status).toBe("open");

    const cfg = await manager.confirmJoin(lobbyId, W[0]!, "sig-1");
    expect(cfg.targetMl).toBe(lobby.targetMl);
    expect(cfg.pressure).toBe(lobby.pressureMilli / 1000);
  });

  it("resumes awaiting_randomness lobbies via waitForRoundFulfilled on boot", async () => {
    manager = makeManager(60_000);
    await manager.init();
    chain.autoFulfill = false;
    const created = manager.createLobby(ENTRY_FEE);
    created.catch(() => undefined); // never fulfilled on this instance
    await sleep(20);
    const lobbyId = chain.createLobbyCalls[0]!.lobbyId;
    manager.dispose(); // simulate crash while the callback is pending

    const chain2 = new MockChainClient(); // fulfills immediately
    manager = makeManager(60_000, chain2);
    await manager.init();
    await sleep(50); // background resume
    const lobby = manager.getLobby(lobbyId)!;
    expect(lobby.status).toBe("open");
    expect(lobby.randomnessHex).not.toBeNull();
    expect([500, 1000, 1500]).toContain(lobby.targetMl);
  });

  it("rejects a double join of the same wallet", async () => {
    manager = makeManager(60_000);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    await manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-1");
    await expect(manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-2")).rejects.toMatchObject({
      code: "ALREADY_JOINED",
    });
  });

  it("rejects a join whose transaction cannot be confirmed", async () => {
    manager = makeManager(60_000);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    chain.confirmJoinResult = false;
    await expect(manager.confirmJoin(lobby.lobbyId, W[0]!, "bogus")).rejects.toMatchObject({
      code: "JOIN_NOT_CONFIRMED",
    });
    expect(manager.getLobby(lobby.lobbyId)!.players).toHaveLength(0);
  });

  it("submits pouredMl=0 when the play timeout expires", async () => {
    manager = makeManager(50);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    await manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-1");
    await sleep(200);
    expect(chain.submitResultCalls).toEqual([
      { lobbyId: lobby.lobbyId, player: W[0]!, pouredMl: 0 },
    ]);
    const p = manager.getPlayer(lobby.lobbyId, W[0]!)!;
    expect(p.status).toBe("done");
    expect(p.timedOut).toBe(true);
  });

  it("re-arms persisted timers after a restart (expired -> immediate 0)", async () => {
    manager = makeManager(50);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    await manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-1");
    manager.dispose(); // simulate crash before the timer fires

    const chain2 = new MockChainClient();
    manager = makeManager(50, chain2);
    await sleep(80); // deadline passes while the server is "down"
    await manager.init();
    await sleep(100);
    expect(chain2.submitResultCalls).toEqual([
      { lobbyId: lobby.lobbyId, player: W[0]!, pouredMl: 0 },
    ]);
  });

  it("enforces a single attempt per player", async () => {
    manager = makeManager(60_000);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    await manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-1");
    await manager.submitPour(lobby.lobbyId, W[0]!, { pouredMl: 900, foamMl: 50, overflow: false });
    await expect(
      manager.submitPour(lobby.lobbyId, W[0]!, { pouredMl: 999, foamMl: 0, overflow: false }),
    ).rejects.toMatchObject({ code: "ALREADY_PLAYED" });
  });

  it("settles automatically at 5/5 results with correct winners and fee", async () => {
    manager = makeManager(60_000);
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    const target = lobby.targetMl;

    const settledEvents: string[] = [];
    manager.onSettled((l) => settledEvents.push(l.lobbyId));

    // 5 joins, then 5 pours; W[1] hits the target exactly, W[4] overflows.
    for (let i = 0; i < 5; i++) {
      await manager.confirmJoin(lobby.lobbyId, W[i]!, `sig-${i}`);
    }
    expect(chain.settleCalls).toHaveLength(0);

    await manager.submitPour(lobby.lobbyId, W[0]!, { pouredMl: target - 40, foamMl: 10, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[1]!, { pouredMl: target, foamMl: 10, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[2]!, { pouredMl: target + 75, foamMl: 10, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[3]!, { pouredMl: 0, foamMl: 0, overflow: false });
    expect(chain.settleCalls).toHaveLength(0); // 4/5 -> not yet

    const res = await manager.submitPour(lobby.lobbyId, W[4]!, {
      pouredMl: 1500,
      foamMl: 200,
      overflow: true,
    });
    expect(res.pouredMl).toBe(OVERFLOW_SENTINEL); // overflow reported as sentinel

    // settlement triggered exactly once (no seed reveal), single winner W[1]
    expect(chain.settleCalls).toEqual([{ lobbyId: lobby.lobbyId, winners: [W[1]!] }]);
    expect(chain.submitResultCalls.find((c) => c.player === W[4]!)!.pouredMl).toBe(
      OVERFLOW_SENTINEL,
    );

    const settled = manager.getLobby(lobby.lobbyId)!;
    expect(settled.status).toBe("settled");
    expect(settledEvents).toEqual([lobby.lobbyId]);
    // pot 5 * 0.1 SOL = 500_000_000; fee 4% = 20_000_000; winner gets the rest
    expect(settled.settlement!.potLamports).toBe("500000000");
    expect(settled.settlement!.feeLamports).toBe("20000000");
    expect(settled.settlement!.payouts).toEqual([{ wallet: W[1]!, lamports: "480000000" }]);
    // the VRF randomness is now echoed publicly (it is on-chain anyway)
    expect(settled.settlement!.randomnessHex).toBe(lobby.randomnessHex);
    expect(manager.publicState(settled).randomnessHex).toBe(lobby.randomnessHex);
  });

  it("splits a tie and gives the lamport remainder to the earlier submission", async () => {
    manager = makeManager(60_000);
    await manager.init();
    // Entry fee chosen so the distributable amount is odd:
    // pot = 5 * 20_000_001 = 100_000_005; fee = 4_000_000 (floor); rest = 96_000_005
    const lobby = await manager.createLobby(20_000_001n);
    const target = lobby.targetMl;

    for (let i = 0; i < 5; i++) {
      await manager.confirmJoin(lobby.lobbyId, W[i]!, `sig-${i}`);
    }
    await manager.submitPour(lobby.lobbyId, W[0]!, { pouredMl: target + 10, foamMl: 0, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[1]!, { pouredMl: target - 10, foamMl: 0, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[2]!, { pouredMl: target + 200, foamMl: 0, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[3]!, { pouredMl: 0, foamMl: 0, overflow: false });
    await manager.submitPour(lobby.lobbyId, W[4]!, { pouredMl: 0, foamMl: 0, overflow: true });

    const s = manager.getLobby(lobby.lobbyId)!.settlement!;
    expect(s.winners).toEqual([W[0]!, W[1]!]); // W[0] submitted first (index 0)
    expect(s.feeLamports).toBe("4000000");
    expect(s.payouts).toEqual([
      { wallet: W[0]!, lamports: "48000003" }, // share 48_000_002 + remainder 1
      { wallet: W[1]!, lamports: "48000002" },
    ]);
  });

  it("cancels an expired unfilled lobby (24h rule)", async () => {
    let nowMs = 1_000_000;
    manager = new LobbyManager({
      chain,
      store: new JsonStore<LobbyStoreData>(path.join(dir, "lobbies.json")),
      lobbySize: 5,
      playTimeoutMs: 60_000,
      cancelAfterS: 86_400,
      now: () => nowMs,
      log: () => undefined,
    });
    await manager.init();
    const lobby = await manager.createLobby(ENTRY_FEE);
    await manager.confirmJoin(lobby.lobbyId, W[0]!, "sig-1");

    expect(await manager.cancelIfExpired(lobby.lobbyId)).toBe(false); // too early
    nowMs += 86_400_000 + 1;
    expect(await manager.cancelIfExpired(lobby.lobbyId)).toBe(true);
    expect(chain.cancelCalls).toEqual([{ lobbyId: lobby.lobbyId, players: [W[0]!] }]);
    expect(manager.getLobby(lobby.lobbyId)!.status).toBe("cancelled");
  });

  it("cancels a lobby stuck in awaiting_randomness after 24h (no refunds needed)", async () => {
    let nowMs = 1_000_000;
    chain.autoFulfill = false;
    manager = new LobbyManager({
      chain,
      store: new JsonStore<LobbyStoreData>(path.join(dir, "lobbies.json")),
      lobbySize: 5,
      playTimeoutMs: 60_000,
      cancelAfterS: 86_400,
      now: () => nowMs,
      log: () => undefined,
    });
    await manager.init();
    const created = manager.createLobby(ENTRY_FEE);
    created.catch(() => undefined); // callback never arrives
    await sleep(20);
    const lobbyId = chain.createLobbyCalls[0]!.lobbyId;
    expect(manager.getLobby(lobbyId)!.status).toBe("awaiting_randomness");

    expect(await manager.cancelIfExpired(lobbyId)).toBe(false); // too early
    nowMs += 86_400_000 + 1;
    expect(await manager.cancelIfExpired(lobbyId)).toBe(true);
    expect(chain.cancelCalls).toEqual([{ lobbyId, players: [] }]);
    expect(manager.getLobby(lobbyId)!.status).toBe("cancelled");

    // a late oracle callback must not reopen a cancelled lobby
    chain.fulfill(lobbyId);
    await sleep(20);
    expect(manager.getLobby(lobbyId)!.status).toBe("cancelled");
  });
});
