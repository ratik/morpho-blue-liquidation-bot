import { DEPLOYMENTS } from "@morpho-blue-liquidation-bot/config";
import { type Address, type Hex, zeroAddress } from "viem";
import * as actions from "viem/actions";
import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getContractEventsMock } = vi.hoisted(() => ({
  getContractEventsMock: vi.fn(),
}));

vi.mock("viem/actions", async () => {
  const actual = await vi.importActual<typeof import("viem/actions")>("viem/actions");
  return {
    ...actual,
    getContractEvents: getContractEventsMock,
  };
});

import { UniswapV4Venue } from "../../src/uniswapV4/index.js";

const USDC = "0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const WBTC = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" as Address;

interface UniswapV4VenueTestHandle {
  fetchPools: (
    encoder: { client: { chain: { id: number } } },
    poolManager: (typeof DEPLOYMENTS)[number]["PoolManager"],
    src: Address,
    dst: Address,
  ) => Promise<{ pools: { id: Hex }[] }>;
  syncPools: (client: { chain: { id: number; name: string } }) => Promise<void>;
  poolKey: (currency0: Address, currency1: Address) => Hex;
  poolCreationEventsCache: Record<
    Hex,
    {
      currency0: Address;
      currency1: Address;
      events: { args: { id: Hex; hooks: Address } }[];
      lastUpdate: number;
    }
  >;
}

function createPoolEvent(currency0: Address, currency1: Address, id: Hex) {
  return {
    args: {
      currency0,
      currency1,
      fee: 3000,
      tickSpacing: 60,
      hooks: zeroAddress,
      id,
    },
  } as Awaited<ReturnType<typeof actions.getContractEvents>>[number];
}

describe("uniswapV4 cache refresh", () => {
  const client = {
    chain: { id: base.id, name: base.name },
  } as Parameters<UniswapV4Venue["init"]>[0];

  beforeEach(() => {
    getContractEventsMock.mockReset();
  });

  it("returns empty pools for unseen pairs without synchronous fetching", async () => {
    const venue = new UniswapV4Venue();
    const testVenue = venue as unknown as UniswapV4VenueTestHandle;
    venue.init(client);

    const result = await testVenue.fetchPools(
      { client },
      DEPLOYMENTS[base.id]!.PoolManager,
      USDC,
      WBTC,
    );

    expect(result.pools).toEqual([]);
    expect(getContractEventsMock).not.toHaveBeenCalled();
  });

  it("refreshes registered pairs in the background using pair-scoped event queries", async () => {
    const venue = new UniswapV4Venue();
    const testVenue = venue as unknown as UniswapV4VenueTestHandle;
    venue.init(client);
    venue.registerTokenPair(USDC, WETH);
    getContractEventsMock.mockResolvedValue([
      createPoolEvent(zeroAddress as Address, USDC, "0x01"),
    ] as Awaited<ReturnType<typeof actions.getContractEvents>>);

    await testVenue.syncPools(client);

    const result = await testVenue.fetchPools(
      { client },
      DEPLOYMENTS[base.id]!.PoolManager,
      zeroAddress as Address,
      USDC,
    );

    expect(getContractEventsMock).toHaveBeenCalledTimes(1);
    expect(getContractEventsMock.mock.calls[0]?.[0]).toBe(client);
    expect(getContractEventsMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        eventName: "Initialize",
        args: expect.objectContaining({ currency0: zeroAddress }),
      }),
    );
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.id).toBe("0x01");
  });

  it("keeps stale cache entries when a background refresh fails", async () => {
    const venue = new UniswapV4Venue();
    const testVenue = venue as unknown as UniswapV4VenueTestHandle;
    venue.init(client);
    venue.registerTokenPair(USDC, WBTC);

    const pairKey = testVenue.poolKey(USDC, WBTC);
    testVenue.poolCreationEventsCache[pairKey] = {
      currency0: USDC,
      currency1: WBTC,
      events: [createPoolEvent(USDC, WBTC, "0x02")],
      lastUpdate: 1,
    };
    getContractEventsMock.mockRejectedValue(new Error("timeout"));

    await testVenue.syncPools(client);

    const result = await testVenue.fetchPools(
      { client },
      DEPLOYMENTS[base.id]!.PoolManager,
      USDC,
      WBTC,
    );

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.id).toBe("0x02");
  });
});
