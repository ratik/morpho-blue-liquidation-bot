import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import type { Address } from "viem";
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

const asset = "0x0000000000000000000000000000000000000001" as Address;

describe("price cache usage", () => {
  beforeEach(() => {
    readContractMock.mockReset();
  });

  it("uses bot-owned cached prices without calling pricers", async () => {
    const price = vi.fn().mockResolvedValue(200);
    const pricer = { price } as unknown as Pricer;

    const context = {
      client: {},
      wNative: "0x4200000000000000000000000000000000000006" as Address,
      priceCache: new Map([[asset, { price: 100, updatedAt: Date.now() }]]),
    };

    readContractMock.mockResolvedValue(18);

    const result = await (
      LiquidationBot.prototype as unknown as {
        price: (
          this: typeof context,
          asset: Address,
          amount: bigint,
          pricers: Pricer[],
        ) => Promise<number | undefined>;
      }
    ).price.call(context, asset, 2n * 10n ** 18n, [pricer]);

    expect(result).toBe(200);
    expect(price).not.toHaveBeenCalled();
  });

  it("computes median price and preserves the previous value when refresh yields no prices", async () => {
    const context = {
      client: {},
      pricers: [
        { price: vi.fn().mockResolvedValue(120) },
        { price: vi.fn().mockResolvedValue(undefined) },
        { price: vi.fn().mockResolvedValue(100) },
        { price: vi.fn().mockResolvedValue(110) },
      ] as Pricer[],
      registeredPricedAssets: new Set([asset]),
      priceCache: new Map<Address, { price: number; updatedAt: number }>(),
      logger: { error: vi.fn() },
      logTag: "[test] ",
      calculateMedian: LiquidationBot.prototype[
        "calculateMedian" as keyof LiquidationBot
      ] as unknown as (prices: number[]) => number,
    };

    await (
      LiquidationBot.prototype as unknown as {
        refreshPriceCache: (this: typeof context) => Promise<void>;
      }
    ).refreshPriceCache.call(context);

    expect(context.priceCache.get(asset)?.price).toBe(110);

    context.pricers = [{ price: vi.fn().mockResolvedValue(undefined) }] as Pricer[];

    await (
      LiquidationBot.prototype as unknown as {
        refreshPriceCache: (this: typeof context) => Promise<void>;
      }
    ).refreshPriceCache.call(context);

    expect(context.priceCache.get(asset)?.price).toBe(110);
  });
});
