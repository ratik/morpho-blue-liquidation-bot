import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import { LiquidationBot } from "../../src/bot.js";

const collateral = "0x0000000000000000000000000000000000000001" as Address;
const intermediate = "0x0000000000000000000000000000000000000002" as Address;
const loan = "0x0000000000000000000000000000000000000003" as Address;

function createVenue(
  venue: Pick<LiquidityVenue, "kind" | "supportsRoute" | "convert">,
): LiquidityVenue {
  return venue as LiquidityVenue;
}

interface BotTestPrototype {
  applyTransformVenues: (
    encoder: unknown,
    initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
  ) => Promise<{ src: Address; dst: Address; srcAmount: bigint }>;
  applySwapVenues: (
    encoder: unknown,
    initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
  ) => Promise<{ src: Address; dst: Address; srcAmount: bigint }>;
  convertCollateralToLoan: (
    this: {
      liquidityVenues: LiquidityVenue[];
      logTag: string;
      applyTransformVenues: BotTestPrototype["applyTransformVenues"];
      applySwapVenues: BotTestPrototype["applySwapVenues"];
    },
    marketParams: { collateralToken: Address; loanToken: Address },
    seizableCollateral: bigint,
    encoder: unknown,
  ) => Promise<boolean>;
}

describe("convertCollateralToLoan", () => {
  it("applies transform venues before swap venues regardless of array order", async () => {
    const calls: string[] = [];

    const swapVenue = createVenue({
      kind: "swap",
      supportsRoute: vi.fn(async (_encoder, src, dst) => {
        calls.push(`swap-supports:${src}->${dst}`);
        return src === intermediate && dst === loan;
      }),
      convert: vi.fn(async (_encoder, toConvert) => {
        calls.push(`swap-convert:${toConvert.src}->${toConvert.dst}`);
        return { ...toConvert, src: toConvert.dst, srcAmount: 0n };
      }),
    });

    const transformVenue = createVenue({
      kind: "transform",
      supportsRoute: vi.fn(async (_encoder, src, dst) => {
        calls.push(`transform-supports:${src}->${dst}`);
        return src === collateral && dst === loan;
      }),
      convert: vi.fn(async (_encoder, toConvert) => {
        calls.push(`transform-convert:${toConvert.src}->${toConvert.dst}`);
        return { ...toConvert, src: intermediate };
      }),
    });

    const botPrototype = LiquidationBot.prototype as unknown as BotTestPrototype;
    const context = {
      liquidityVenues: [swapVenue, transformVenue],
      logTag: "[test] ",
      applyTransformVenues: botPrototype.applyTransformVenues as (
        encoder: unknown,
        initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
      ) => Promise<{ src: Address; dst: Address; srcAmount: bigint }>,
      applySwapVenues: botPrototype.applySwapVenues as (
        encoder: unknown,
        initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
      ) => Promise<{ src: Address; dst: Address; srcAmount: bigint }>,
    };

    const success = await botPrototype.convertCollateralToLoan.call(
      context,
      { collateralToken: collateral, loanToken: loan },
      1n,
      {},
    );

    expect(success).toBe(true);
    expect(calls).toEqual([
      `transform-supports:${collateral}->${loan}`,
      `transform-convert:${collateral}->${loan}`,
      `transform-supports:${intermediate}->${loan}`,
      `swap-supports:${intermediate}->${loan}`,
      `swap-convert:${intermediate}->${loan}`,
    ]);
  });
});
