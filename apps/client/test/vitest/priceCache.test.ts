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

  it("prefers cached prices over live pricer requests", async () => {
    const getCachedPrice = vi.fn().mockResolvedValue(100);
    const price = vi.fn().mockResolvedValue(200);
    const pricer = { getCachedPrice, price } as unknown as Pricer;

    const context = {
      client: {},
      wNative: "0x4200000000000000000000000000000000000006" as Address,
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
    expect(getCachedPrice).toHaveBeenCalledTimes(1);
    expect(price).not.toHaveBeenCalled();
  });
});
