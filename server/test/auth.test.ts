import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { AuthService, isValidWallet } from "../src/auth.js";
import { LOGIN_MESSAGE_PREFIX } from "../src/game/constants.js";

const SECRET = Buffer.from("test-secret-do-not-use-in-prod");

function makeWallet(): { wallet: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { wallet: bs58.encode(kp.publicKey), secretKey: kp.secretKey };
}

function signLogin(nonce: string, secretKey: Uint8Array): string {
  const msg = new TextEncoder().encode(`${LOGIN_MESSAGE_PREFIX}${nonce}`);
  return bs58.encode(nacl.sign.detached(msg, secretKey));
}

describe("AuthService", () => {
  it("accepts a valid ed25519 signature over 'ZAPF ROYALE LOGIN <nonce>'", () => {
    const auth = new AuthService(SECRET);
    const { wallet, secretKey } = makeWallet();
    const nonce = auth.createNonce(wallet);
    expect(auth.loginMessage(nonce)).toBe(`ZAPF ROYALE LOGIN ${nonce}`);

    const token = auth.verifyLogin(wallet, signLogin(nonce, secretKey));
    expect(token).toBeTruthy();
    expect(auth.verifyToken(token!)).toBe(wallet);
  });

  it("rejects a signature from the wrong key", () => {
    const auth = new AuthService(SECRET);
    const { wallet } = makeWallet();
    const attacker = makeWallet();
    const nonce = auth.createNonce(wallet);
    expect(auth.verifyLogin(wallet, signLogin(nonce, attacker.secretKey))).toBeNull();
  });

  it("rejects a signature over the wrong nonce", () => {
    const auth = new AuthService(SECRET);
    const { wallet, secretKey } = makeWallet();
    auth.createNonce(wallet);
    expect(auth.verifyLogin(wallet, signLogin("deadbeef", secretKey))).toBeNull();
  });

  it("consumes the nonce on success (no replay)", () => {
    const auth = new AuthService(SECRET);
    const { wallet, secretKey } = makeWallet();
    const nonce = auth.createNonce(wallet);
    const sig = signLogin(nonce, secretKey);
    expect(auth.verifyLogin(wallet, sig)).toBeTruthy();
    expect(auth.verifyLogin(wallet, sig)).toBeNull();
  });

  it("rejects unknown wallets and garbage signatures", () => {
    const auth = new AuthService(SECRET);
    const { wallet } = makeWallet();
    expect(auth.verifyLogin(wallet, "AAAA")).toBeNull(); // no nonce requested
    const nonce = auth.createNonce(wallet);
    expect(nonce).toBeTruthy();
    expect(auth.verifyLogin(wallet, "not-base58-!!!")).toBeNull();
  });

  it("rejects expired nonces", () => {
    let now = 1_000_000;
    const auth = new AuthService(SECRET, () => now);
    const { wallet, secretKey } = makeWallet();
    const nonce = auth.createNonce(wallet);
    now += 5 * 60_000 + 1;
    expect(auth.verifyLogin(wallet, signLogin(nonce, secretKey))).toBeNull();
  });

  it("rejects tampered and expired tokens", () => {
    let now = 1_000_000;
    const auth = new AuthService(SECRET, () => now, 1000);
    const { wallet, secretKey } = makeWallet();
    const nonce = auth.createNonce(wallet);
    const token = auth.verifyLogin(wallet, signLogin(nonce, secretKey))!;

    // tamper with the payload
    const [body, mac] = token.split(".") as [string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ wallet: makeWallet().wallet, iat: now, exp: now + 9999 }),
    ).toString("base64url");
    expect(auth.verifyToken(`${forgedPayload}.${mac}`)).toBeNull();
    expect(auth.verifyToken(`${body}.${"A".repeat(mac.length)}`)).toBeNull();
    expect(auth.verifyToken("garbage")).toBeNull();

    // expiry
    now += 1001;
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("validates wallet format", () => {
    const { wallet } = makeWallet();
    expect(isValidWallet(wallet)).toBe(true);
    expect(isValidWallet("not-a-wallet-0OIl")).toBe(false);
    expect(isValidWallet("abc")).toBe(false);
  });
});
