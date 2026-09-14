import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S3BlobStore } from "./s3.js";
import {
  canonicalQueryString,
  canonicalUri,
  signRequest,
  uriEncode,
} from "./sigv4.js";

const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("signRequest", () => {
  /**
   * AWS's own published `get-vanilla` vector from the SigV4 test suite.
   *
   * The whole point of hand-rolling this: without an authoritative vector it is
   * only "a signature", not "the right signature". Everything else in this file
   * tests behaviour around the signer; this tests the signer itself.
   */
  it("matches the AWS get-vanilla test vector exactly", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      credentials: CREDENTIALS,
      now: new Date("2015-08-30T12:36:00Z"),
    });

    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  const base = {
    method: "PUT",
    url: "https://bucket.s3.eu-west-1.amazonaws.com/backups/abc/one",
    region: "eu-west-1",
    service: "s3",
    credentials: CREDENTIALS,
    body: new TextEncoder().encode("payload"),
    now: new Date("2026-09-08T12:00:00Z"),
  } as const;

  const signatureOf = (over: Partial<typeof base> = {}) =>
    /Signature=([0-9a-f]+)/.exec(
      signRequest({ ...base, ...over }).headers.Authorization,
    )?.[1];

  it("is deterministic for identical inputs", () => {
    expect(signatureOf()).toBe(signatureOf());
  });

  // Each of these is part of the canonical request; if changing one doesn't
  // change the signature, it isn't actually being signed.
  it("covers the method, path, body, date and region", () => {
    const baseline = signatureOf();

    expect(signatureOf({ method: "GET" })).not.toBe(baseline);
    expect(
      signatureOf({ url: "https://bucket.s3.eu-west-1.amazonaws.com/backups/abc/two" }),
    ).not.toBe(baseline);
    expect(signatureOf({ body: new TextEncoder().encode("tampered") })).not.toBe(
      baseline,
    );
    expect(signatureOf({ now: new Date("2026-09-08T12:00:01Z") })).not.toBe(baseline);
    expect(signatureOf({ region: "us-east-1" })).not.toBe(baseline);
  });

  it("signs any x-amz header it is given", () => {
    const withMeta = signRequest({
      ...base,
      headers: { "x-amz-meta-manifest": "abc" },
    });
    expect(withMeta.headers.Authorization).toContain("x-amz-meta-manifest");
  });

  it("adds a session token when using temporary credentials", () => {
    const signed = signRequest({
      ...base,
      credentials: { ...CREDENTIALS, sessionToken: "tok" },
    });
    expect(signed.headers["x-amz-security-token"]).toBe("tok");
    expect(signed.headers.Authorization).toContain("x-amz-security-token");
  });
});

describe("canonicalisation", () => {
  // encodeURIComponent disagrees with AWS on exactly these characters, and only
  // keys containing them expose it.
  it("encodes the characters encodeURIComponent gets wrong", () => {
    expect(uriEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(uriEncode("a~b")).toBe("a~b");
    expect(uriEncode("a b")).toBe("a%20b");
  });

  it("preserves path separators while encoding segments", () => {
    expect(canonicalUri("/backups/a b/c")).toBe("/backups/a%20b/c");
    expect(canonicalUri("/")).toBe("/");
  });

  it("sorts query parameters by key then value", () => {
    const params = new URLSearchParams();
    params.append("prefix", "b");
    params.append("list-type", "2");
    params.append("continuation-token", "t");

    expect(canonicalQueryString(params)).toBe(
      "continuation-token=t&list-type=2&prefix=b",
    );
  });
});

/**
 * The store, driven against a real S3-speaking HTTP server over a real socket.
 *
 * A mocked fetch would prove the class calls a function; this proves the
 * requests it builds are shaped the way S3 expects — correct verbs, paths,
 * metadata headers and list XML — and that bytes survive the round trip.
 */
describe("S3BlobStore", () => {
  let server: Server;
  let endpoint: string;
  let objects: Map<string, { body: Buffer; manifest: string | null }>;
  let requests: { method: string; url: string; auth: string | null }[];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization ?? null,
      });

      // Every request must be signed; an unsigned one is a bug worth failing on.
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        res.writeHead(403).end();
        return;
      }

      const isList = url.searchParams.get("list-type") === "2";
      // Path style: /<bucket>/<key...>
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));

      if (isList) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { "content-type": "application/xml" }).end(
          `<?xml version="1.0"?><ListBucketResult>${matching
            .map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`)
            .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
        return;
      }

      if (req.method === "PUT") {
        objects.set(key, {
          body,
          manifest: (req.headers["x-amz-meta-manifest"] as string) ?? null,
        });
        res.writeHead(200).end();
        return;
      }

      const found = objects.get(key);

      if (req.method === "GET" || req.method === "HEAD") {
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(found.manifest ? { "x-amz-meta-manifest": found.manifest } : {}),
        });
        res.end(req.method === "HEAD" ? undefined : found.body);
        return;
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }

      res.writeHead(405).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    objects = new Map();
    requests = [];
  });

  const store = (over: Partial<ConstructorParameters<typeof S3BlobStore>[0]> = {}) =>
    new S3BlobStore({
      bucket: "dsv-backups",
      region: "eu-west-1",
      credentials: CREDENTIALS,
      endpoint,
      ...over,
    });

  it("round-trips bytes and metadata", async () => {
    const s3 = store();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);

    await s3.put("backups/ns/one", bytes, {
      createdAt: "2026-09-08T11:00:00.000Z",
      algorithm: "AES-256-GCM",
    });

    const blob = await s3.get("backups/ns/one");
    expect(blob?.bytes).toEqual(bytes);
    // S3 lowercases per-field metadata keys, which is why the manifest travels
    // as one encoded header — camelCase has to survive.
    expect(blob?.metadata.createdAt).toBe("2026-09-08T11:00:00.000Z");
    expect(blob?.metadata.algorithm).toBe("AES-256-GCM");
  });

  it("signs every request", async () => {
    const s3 = store();
    await s3.put("backups/ns/one", new Uint8Array([1]), {});
    await s3.get("backups/ns/one");
    await s3.list("backups/ns/");
    await s3.delete("backups/ns/one");

    expect(requests.length).toBeGreaterThan(3);
    for (const request of requests) {
      expect(request.auth).toMatch(/^AWS4-HMAC-SHA256 /);
    }
  });

  it("returns null for a missing object rather than throwing", async () => {
    await expect(store().get("backups/ns/nope")).resolves.toBeNull();
  });

  it("treats deleting a missing object as done", async () => {
    await expect(store().delete("backups/ns/nope")).resolves.toBeUndefined();
  });

  it("lists keys under a prefix with their metadata", async () => {
    const s3 = store();
    await s3.put("backups/ns/one", new Uint8Array([1]), { createdAt: "a" });
    await s3.put("backups/ns/two", new Uint8Array([2]), { createdAt: "b" });
    await s3.put("backups/other/three", new Uint8Array([3]), { createdAt: "c" });

    const entries = await s3.list("backups/ns/");

    expect(entries.map((e) => e.key).sort()).toEqual([
      "backups/ns/one",
      "backups/ns/two",
    ]);
    expect(entries.find((e) => e.key.endsWith("one"))?.metadata.createdAt).toBe("a");
  });

  it("keeps one bucket usable by more than this service", async () => {
    const s3 = store({ prefix: "store-validator/" });
    await s3.put("backups/ns/one", new Uint8Array([1]), {});

    // Stored under the prefix...
    expect([...objects.keys()]).toEqual(["store-validator/backups/ns/one"]);
    // ...but callers never see it.
    expect((await s3.list("backups/")).map((e) => e.key)).toEqual([
      "backups/ns/one",
    ]);
    expect(await s3.get("backups/ns/one")).not.toBeNull();
  });

  it("survives a key needing percent-encoding", async () => {
    const s3 = store();
    // Our own keys are hex and UUIDs, but a signature that only works for
    // simple keys is a latent bug, not a working implementation.
    await s3.put("backups/ns/a b~c", new Uint8Array([7]), {});
    expect((await s3.get("backups/ns/a b~c"))?.bytes).toEqual(new Uint8Array([7]));
  });

  it("reports a storage failure without leaking the request", async () => {
    const s3 = new S3BlobStore({
      bucket: "dsv-backups",
      region: "eu-west-1",
      credentials: CREDENTIALS,
      endpoint,
      fetchImpl: (async () => new Response("<Error>...</Error>", { status: 500 })) as never,
    });

    await expect(s3.put("k", new Uint8Array([1]), {})).rejects.toMatchObject({
      code: "CLOUD_REQUEST_FAILED",
      detail: "HTTP 500",
    });
  });

  it("reports an unreachable endpoint in plain language", async () => {
    const s3 = new S3BlobStore({
      bucket: "dsv-backups",
      region: "eu-west-1",
      credentials: CREDENTIALS,
      endpoint: "http://127.0.0.1:1",
    });

    await expect(s3.get("k")).rejects.toMatchObject({
      message: expect.stringMatching(/couldn't reach backup storage/i),
    });
  });

  it("refuses to construct without a bucket", () => {
    expect(
      () =>
        new S3BlobStore({
          bucket: "",
          region: "eu-west-1",
          credentials: CREDENTIALS,
        }),
    ).toThrow(/isn't configured/i);
  });
});
