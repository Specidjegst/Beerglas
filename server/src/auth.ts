/**
 * Nonce-based wallet login.
 *
 * Flow:
 *   1. POST /auth/nonce  { wallet }                  -> { nonce }
 *   2. Wallet signs the UTF-8 message "ZAPF ROYALE LOGIN <nonce>".
 *   3. POST /auth/verify { wallet, signature(b58) }  -> { token }
 *
 * The token is a compact HMAC-SHA256-signed blob (no external JWT package):
 *   base64url(JSON payload) + "." + base64url(HMAC(payload))
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { LOGIN_MESSAGE_PREFIX } from "./game/constants.js";
import type { JsonStore } from "./persistence.js";

const NONCE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 24 * 60 * 60_000;

export interface NonceStoreData {
  nonces: Record<string, { nonce: string; expiresAt: number }>;
}

interface TokenPayload {
  wallet: string;
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** True iff `s` is a base58 string decoding to exactly 32 bytes (an ed25519 pubkey). */
export function isValidWallet(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export class AuthService {
  private readonly nonces = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    private readonly secret: Buffer,
    private readonly now: () => number = Date.now,
    private readonly tokenTtlMs: number = TOKEN_TTL_MS,
    private readonly store?: JsonStore<NonceStoreData>,
  ) {}

  /** Load persisted nonces (optional; nonces are short-lived anyway). */
  async init(): Promise<void> {
    if (!this.store) return;
    const data = await this.store.load({ nonces: {} });
    const now = this.now();
    for (const [wallet, entry] of Object.entries(data.nonces)) {
      if (entry.expiresAt >= now) this.nonces.set(wallet, entry);
    }
  }

  private persist(): void {
    if (!this.store) return;
    const nonces: NonceStoreData["nonces"] = {};
    for (const [wallet, entry] of this.nonces) nonces[wallet] = entry;
    void this.store.save({ nonces }).catch(() => undefined);
  }

  /** Issue a single-use login nonce for a wallet. Overwrites any previous one. */
  createNonce(wallet: string): string {
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(wallet, { nonce, expiresAt: this.now() + NONCE_TTL_MS });
    this.persist();
    return nonce;
  }

  /** The exact message the wallet must sign for the given nonce. */
  loginMessage(nonce: string): string {
    return `${LOGIN_MESSAGE_PREFIX}${nonce}`;
  }

  /**
   * Verify the ed25519 signature over the login message and issue a token.
   * Returns null on any failure (unknown/expired nonce, bad signature).
   * The nonce is consumed on success (single use).
   */
  verifyLogin(wallet: string, signatureB58: string): string | null {
    const entry = this.nonces.get(wallet);
    if (!entry || entry.expiresAt < this.now()) {
      if (this.nonces.delete(wallet)) this.persist();
      return null;
    }
    let signature: Uint8Array;
    let pubkey: Uint8Array;
    try {
      signature = bs58.decode(signatureB58);
      pubkey = bs58.decode(wallet);
    } catch {
      return null;
    }
    if (signature.length !== 64 || pubkey.length !== 32) return null;

    const message = new TextEncoder().encode(this.loginMessage(entry.nonce));
    const ok = nacl.sign.detached.verify(message, signature, pubkey);
    if (!ok) return null;

    this.nonces.delete(wallet);
    this.persist();
    return this.issueToken(wallet);
  }

  issueToken(wallet: string): string {
    const iat = this.now();
    const payload: TokenPayload = { wallet, iat, exp: iat + this.tokenTtlMs };
    const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const mac = b64url(createHmac("sha256", this.secret).update(body).digest());
    return `${body}.${mac}`;
  }

  /** Returns the wallet for a valid, unexpired token; null otherwise. */
  verifyToken(token: string): string | null {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(body).digest();
    let given: Buffer;
    try {
      given = Buffer.from(mac, "base64url");
    } catch {
      return null;
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
      if (typeof payload.wallet !== "string" || typeof payload.exp !== "number") return null;
      if (payload.exp < this.now()) return null;
      return payload.wallet;
    } catch {
      return null;
    }
  }

  /** Drop expired nonces (housekeeping; the map is small either way). */
  pruneNonces(): void {
    const now = this.now();
    let changed = false;
    for (const [wallet, entry] of this.nonces) {
      if (entry.expiresAt < now) {
        this.nonces.delete(wallet);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.post("/auth/nonce", async (req, reply) => {
    const body = (req.body ?? {}) as { wallet?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (!isValidWallet(wallet)) {
      return reply.code(400).send({ error: "invalid wallet" });
    }
    const nonce = auth.createNonce(wallet);
    return reply.send({ nonce, message: auth.loginMessage(nonce) });
  });

  app.post("/auth/verify", async (req, reply) => {
    const body = (req.body ?? {}) as { wallet?: unknown; signature?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!isValidWallet(wallet) || signature.length === 0) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const token = auth.verifyLogin(wallet, signature);
    if (!token) {
      return reply.code(401).send({ error: "signature verification failed" });
    }
    return reply.send({ token });
  });
}
