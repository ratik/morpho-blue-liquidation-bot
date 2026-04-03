import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MorphoApi } from "../../src";

const asset = "0x0000000000000000000000000000000000000001" as Address;

function createClient(chain: typeof mainnet | typeof base) {
  return { chain } as Parameters<MorphoApi["refreshRegisteredAssets"]>[0];
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

  it("refreshes registered assets and serves cached prices within TTL", async () => {
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
    pricer.registerAsset(asset);

    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBe(123.45);
    expect(pricer.getCachedPrice(client, asset)).toBe(123.45);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("background refresh updates the cached price on the next cycle", async () => {
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
    pricer.registerAsset(asset);

    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBe(100);
    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBe(200);
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
    pricer.registerAsset(asset);

    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBeUndefined();
    expect(pricer.getCachedPrice(client, asset)).toBeUndefined();
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
    pricer.registerAsset(asset);

    await pricer.refreshRegisteredAssets(createClient(mainnet));
    await pricer.refreshRegisteredAssets(createClient(base));
    expect(pricer.getCachedPrice(createClient(mainnet), asset)).toBe(100);
    expect(pricer.getCachedPrice(createClient(base), asset)).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves a previous cached value when refresh fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockJsonResponse({ data: { chains: [{ id: mainnet.id }] } }))
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: { assets: { items: [{ address: asset, priceUsd: 100 }] } },
        }),
      )
      .mockRejectedValueOnce(new Error("boom"));

    const pricer = new MorphoApi();
    const client = createClient(mainnet);
    pricer.registerAsset(asset);

    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBe(100);
    await pricer.refreshRegisteredAssets(client);
    expect(pricer.getCachedPrice(client, asset)).toBe(100);
    await expect(pricer.price(client, asset)).resolves.toBe(100);
  });
});
