import { LIQUID_SWAP_SUPPORTED_NETWORKS } from "@morpho-blue-liquidation-bot/config";
import { ExecutorEncoder } from "executooor-viem";
import { Account, Address, Chain, Client, erc20Abi, Hex, parseUnits, Transport } from "viem";

import { LiquidityVenue } from "../liquidityVenue";
import { createLogger, serializeError } from "../logger";
import { readContractWithRpcStats } from "../rpcActions";
import { ToConvert } from "../types";

import { SwapRouteV2Response } from "./types";

const logger = createLogger({ component: "liquid-swap-venue" });

export class LiquidSwapVenue implements LiquidityVenue {
  kind = "swap" as const;
  private assetsDecimals: Record<number, Record<Address, number>> = {};
  private baseApiUrl = "https://api.liqd.ag/v2/route";
  private quoteCacheTtlMs = 5_000;
  private quoteCache = new Map<string, { response: SwapRouteV2Response; timestamp: number }>();

  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    return LIQUID_SWAP_SUPPORTED_NETWORKS.includes(encoder.client.chain.id);
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    try {
      const srcDecimals = await this.getAssetsDecimals(encoder.client, src);

      const amountIn = Math.floor(Number(srcAmount) / 10 ** srcDecimals);
      const cacheKey = `${encoder.client.chain.id}:${src}:${dst}:${amountIn}`;
      const cached = this.quoteCache.get(cacheKey);
      const data =
        cached && Date.now() - cached.timestamp < this.quoteCacheTtlMs
          ? cached.response
          : await this.fetchRoute(cacheKey, src, dst, amountIn);

      if (!data.success || !data.execution) {
        throw new Error("failed to fetch liquid swap route");
      }

      encoder.erc20Approve(src, data.execution.to as Address, srcAmount);
      encoder.pushCall(data.execution.to as Address, 0n, data.execution.calldata as Hex);

      return {
        src: dst,
        dst,
        srcAmount: parseUnits(data.amountOut, data.tokens.tokenOut.decimals),
      };
    } catch (error) {
      logger.error(
        { src, dst, chainId: encoder.client.chain.id, error: serializeError(error) },
        "failed to fetch assets decimals or liquid swap route",
      );
      return toConvert;
    }
  }

  private apiUrl(src: Address, dst: Address, amount: number) {
    return `${this.baseApiUrl}?tokenIn=${src}&tokenOut=${dst}&amountIn=${amount}`;
  }

  private async fetchRoute(cacheKey: string, src: Address, dst: Address, amount: number) {
    const url = this.apiUrl(src, dst, amount);
    const response = await fetch(url);
    const data = (await response.json()) as SwapRouteV2Response;
    this.quoteCache.set(cacheKey, { response: data, timestamp: Date.now() });
    return data;
  }

  private async getAssetsDecimals(client: Client<Transport, Chain, Account>, asset: Address) {
    const chainId = client.chain.id;
    this.assetsDecimals[chainId] ??= {};

    const chainDecimals = this.assetsDecimals[chainId];
    if (chainDecimals[asset] === undefined) {
      chainDecimals[asset] = (await readContractWithRpcStats(client, "liquidity_routing", {
        address: asset,
        abi: erc20Abi,
        functionName: "decimals",
      })) as number;
    }
    return chainDecimals[asset];
  }
}
