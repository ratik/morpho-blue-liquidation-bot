import {
  API_REFRESH_INTERVAL,
  PENDLE_API_URL,
  PENDLE_SLIPPAGE,
} from "@morpho-blue-liquidation-bot/config";
import { BigIntish } from "@morpho-org/blue-sdk";
import { type ExecutorEncoder } from "executooor-viem";
import { type Address, getAddress, maxUint256 } from "viem";

import type { LiquidityVenue, LiquidityVenueClient } from "../liquidityVenue";
import { createLogger, serializeError } from "../logger";
import type { ToConvert } from "../types";

import {
  PendleMarket,
  PendleMarketsResponse,
  RedeemParams,
  SwapCallData,
  SwapParams,
} from "./types";

const logger = createLogger({ component: "pendle-pt-venue" });

async function getApiData<T extends {}, U>(
  chainId: number,
  endpoint: string,
  params: T,
  api: "sdk" | "non-sdk" = "sdk",
) {
  const queryParams = new URLSearchParams(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    Object.entries(params).map(([key, value]) => [key, String(value)]) as [string, string][],
  ).toString();

  const apiPath = api === "sdk" ? `v2/sdk/${chainId}` : `v2/${chainId}`;
  const url = `${PENDLE_API_URL}${apiPath}${endpoint}?${queryParams}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) throw new Error(res.statusText);

  return res.json() as Promise<U>;
}

async function getMarkets(chainId: number) {
  const url = `${PENDLE_API_URL}v1/markets/all?chainId=${chainId}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) throw new Error(res.statusText);

  return res.json() as Promise<PendleMarketsResponse>;
}

async function getSwapCallData(chainId: number, marketAddress: string, params: SwapParams) {
  return getApiData<SwapParams, SwapCallData>(chainId, `/markets/${marketAddress}/swap`, params);
}

async function getRedeemCallData(chainId: number, params: RedeemParams) {
  return getApiData<RedeemParams, SwapCallData>(chainId, "/redeem", params);
}

export class PendlePTVenue implements LiquidityVenue {
  kind = "transform" as const;
  private pendleMarkets: Record<number, PendleMarketsResponse | undefined> = {};
  private lastPoolRefresh: Record<number, number | undefined> = {};
  private backgroundSyncTimers: Record<number, ReturnType<typeof setInterval> | undefined> = {};

  async init(client: LiquidityVenueClient) {
    await this.refreshMarkets(client.chain.id);
  }

  startBackgroundSync(client: LiquidityVenueClient) {
    const chainId = client.chain.id;
    if (this.backgroundSyncTimers[chainId] !== undefined) return;

    this.backgroundSyncTimers[chainId] = setInterval(() => {
      void this.refreshMarkets(chainId).catch(() => undefined);
    }, API_REFRESH_INTERVAL);
  }

  stopBackgroundSync() {
    for (const chainId of Object.keys(this.backgroundSyncTimers)) {
      const timer = this.backgroundSyncTimers[Number(chainId)];
      if (timer !== undefined) {
        clearInterval(timer);
        this.backgroundSyncTimers[Number(chainId)] = undefined;
      }
    }
  }

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    if (this.pendleMarkets[encoder.client.chain.id] === undefined) {
      await this.refreshMarkets(encoder.client.chain.id);
    }

    return this.isPT(src, encoder.client.chain.id);
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    if (this.pendleMarkets[encoder.client.chain.id] === undefined) {
      await this.refreshMarkets(encoder.client.chain.id);
    }

    const chainMarkets = this.pendleMarkets[encoder.client.chain.id];
    if (!chainMarkets) throw new Error("(PendlePT) Markets not loaded");
    const pendleMarket = chainMarkets.markets.find((marketInfo) => {
      const ptAddress = marketInfo.pt.split("-")[1];
      return ptAddress === src.toLowerCase();
    });
    if (pendleMarket === undefined) {
      throw Error("Invalid Pendle market result");
    }
    const maturity = pendleMarket.expiry;
    if (!maturity) {
      throw Error("Pendle market not found");
    }

    const underlyingToken = pendleMarket.underlyingAsset.split("-")[1];
    if (!underlyingToken) throw new Error("(PendlePT) Invalid underlying asset format");
    let amountOut = 0n;

    if (new Date(maturity) < new Date()) {
      // Pendle market is expired, we can directly redeem the collateral
      // If called before YT's expiry, both PT & YT of equal amounts are needed and will be burned. Else, only PT is needed and will be burned.
      try {
        amountOut = await this.redeemPToUnderlying(
          encoder,
          pendleMarket,
          srcAmount,
          src,
          underlyingToken,
        );
      } catch (error) {
        throw new Error(
          `(PendlePT) Error redeeming PT to underlying: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      // Pendle market is not expired, we need to swap the collateral token (PT) to the underlying token
      try {
        amountOut = await this.swapPTToUnderlying(
          encoder,
          pendleMarket,
          srcAmount,
          src,
          underlyingToken,
        );
      } catch (error) {
        throw new Error(
          `(PendlePT) Error swapping PT to underlying: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      src: getAddress(underlyingToken),
      dst,
      srcAmount: amountOut,
    };
  }

  private async redeemPToUnderlying(
    encoder: ExecutorEncoder,
    pendleMarket: PendleMarket,
    srcAmount: bigint,
    src: Address,
    underlyingToken: string,
  ) {
    const redeemCallData = await getRedeemCallData(encoder.client.chain.id, {
      receiver: encoder.address,
      slippage: PENDLE_SLIPPAGE,
      yt: pendleMarket.yt.split("-")[1] ?? "",
      amountIn: srcAmount.toString(),
      tokenOut: underlyingToken,
      enableAggregator: true,
    });

    encoder
      .erc20Approve(src, redeemCallData.tx.to, maxUint256)
      .pushCall(
        redeemCallData.tx.to,
        redeemCallData.tx.value ? BigInt(redeemCallData.tx.value) : 0n,
        redeemCallData.tx.data,
      );

    return BigInt(redeemCallData.data.amountOut);
  }

  private async swapPTToUnderlying(
    encoder: ExecutorEncoder,
    pendleMarket: PendleMarket,
    srcAmount: bigint,
    src: Address,
    underlyingToken: string,
  ) {
    const swapCallData = await getSwapCallData(encoder.client.chain.id, pendleMarket.address, {
      receiver: encoder.address,
      slippage: PENDLE_SLIPPAGE,
      tokenIn: src.toLowerCase(),
      tokenOut: underlyingToken,
      amountIn: srcAmount.toString(),
    });
    encoder
      .erc20Approve(src, swapCallData.tx.to, maxUint256)
      .pushCall(
        swapCallData.tx.to,
        swapCallData.tx.value ? BigInt(swapCallData.tx.value) : 0n,
        swapCallData.tx.data,
      );

    return BigInt(swapCallData.data.amountOut);
  }

  private isPT(token: string, chainId: BigIntish) {
    return (
      this.pendleMarkets[Number(chainId)]?.markets.some((marketInfo) => {
        const ptAddress = marketInfo.pt.split("-")[1];
        return ptAddress === token.toLowerCase();
      }) ?? false
    );
  }

  private async refreshMarkets(chainId: number) {
    try {
      this.pendleMarkets[chainId] = await getMarkets(chainId);
      this.lastPoolRefresh[chainId] = Date.now();
    } catch (error) {
      logger.error(
        { chainId, error: serializeError(error) },
        "failed to refresh pendle markets cache",
      );
      throw new Error(
        `(PendlePT) Error fetching pendle tokens: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
