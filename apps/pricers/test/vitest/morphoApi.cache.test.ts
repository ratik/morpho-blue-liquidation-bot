import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MorphoApi } from "../../src";

const asset = "0x0000000000000000000000000000000000000001" as Address;

function createClient(chain: typeof mainnet | typeof base) {
  return { chain } as Parameters<MorphoApi["price"]>[0];
}

function mockJsonResponse(body: unknown) {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("morpho api pricer cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:00.000Z"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses cached prices within TTL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockJsonResponse({ data: { chains: [{ id: mainnet.id }] } }))
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 123.45 }] } },
        }),
      );

    const pricer = new MorphoApi();
    const client = createClient(mainnet);

    expect(await pricer.price(client, asset)).toBe(123.45);
    expect(await pricer.price(client, asset)).toBe(123.45);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the cache after TTL expiry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockJsonResponse({ data: { chains: [{ id: mainnet.id }] } }))
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 100 }] } },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 200 }] } },
        }),
      );

    const pricer = new MorphoApi();
    const client = createClient(mainnet);

    expect(await pricer.price(client, asset)).toBe(100);
    vi.advanceTimersByTime(30_001);
    expect(await pricer.price(client, asset)).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caches undefined results within TTL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockJsonResponse({ data: { chains: [{ id: mainnet.id }] } }))
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [] } },
        }),
      );

    const pricer = new MorphoApi();
    const client = createClient(mainnet);

    expect(await pricer.price(client, asset)).toBeUndefined();
    expect(await pricer.price(client, asset)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses chain-aware cache keys", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { chains: [{ id: mainnet.id }, { id: base.id }] },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 100 }] } },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 200 }] } },
        }),
      );

    const pricer = new MorphoApi();

    expect(await pricer.price(createClient(mainnet), asset)).toBe(100);
    expect(await pricer.price(createClient(base), asset)).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns undefined when fetch fails without a cached value", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockJsonResponse({ data: { chains: [{ id: mainnet.id }] } }))
      .mockRejectedValueOnce(new Error("boom"));

    const pricer = new MorphoApi();

    await expect(pricer.price(createClient(mainnet), asset)).resolves.toBeUndefined();
  });
});
