import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readContractMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
}));

vi.mock("viem/actions", async () => {
  const actual = await vi.importActual<typeof import("viem/actions")>("viem/actions");
  return {
    ...actual,
    readContract: readContractMock,
  };
});

import { LiquidationBot } from "../../src/bot.js";

const collateral = "0x0000000000000000000000000000000000000001" as Address;
const loan = "0x0000000000000000000000000000000000000002" as Address;
const marketA = "0x00000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const marketB = "0x00000000000000000000000000000000000000000000000000000000000000bb" as Hex;

interface SeedLiquidityVenuePairsContext {
  liquidityVenues: LiquidityVenue[];
  pricers?: unknown[];
  coveredMarkets: Hex[];
  client: object;
  chainAddresses: { morpho: Address };
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  logTag: string;
  wNative: Address;
  registeredPricedAssets: Set<Address>;
  decimalsCache: Map<Address, number>;
  ensureDecimalsCached: () => Promise<void>;
}

describe("seedMarketDerivedCaches", () => {
  beforeEach(() => {
    readContractMock.mockReset();
  });

  it("registers collateral to loan pairs and bot-priced assets for covered markets", async () => {
    const registerTokenPair = vi.fn();
    const venue = {
      kind: "swap",
      supportsRoute: vi.fn(),
      convert: vi.fn(),
      registerTokenPair,
    } as unknown as LiquidityVenue;

    readContractMock
      .mockResolvedValueOnce([loan, collateral, collateral, collateral, 0n])
      .mockResolvedValueOnce([loan, collateral, collateral, collateral, 0n]);

    const context: SeedLiquidityVenuePairsContext = {
      liquidityVenues: [venue],
      pricers: [{}],
      coveredMarkets: [marketA, marketB],
      client: { chain: { id: 8453 } },
      chainAddresses: { morpho: collateral },
      logger: { info: vi.fn(), error: vi.fn() },
      logTag: "[test] ",
      wNative: "0x4200000000000000000000000000000000000006" as Address,
      registeredPricedAssets: new Set(),
      decimalsCache: new Map(),
      ensureDecimalsCached: vi.fn().mockResolvedValue(undefined),
    };

    await (
      LiquidationBot.prototype as unknown as {
        seedMarketDerivedCaches: (this: SeedLiquidityVenuePairsContext) => Promise<void>;
      }
    ).seedMarketDerivedCaches.call(context);

    expect(registerTokenPair).toHaveBeenCalledTimes(1);
    expect(registerTokenPair).toHaveBeenCalledWith(collateral, loan);
    expect([...context.registeredPricedAssets]).toEqual(
      expect.arrayContaining([collateral, loan, context.wNative]),
    );
    expect(context.ensureDecimalsCached).toHaveBeenCalledTimes(1);
  });
});
