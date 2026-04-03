import { DEPLOYMENTS } from "@morpho-blue-liquidation-bot/config";
import { CommandType, RoutePlanner } from "@uniswap/universal-router-sdk";
import { Actions, type PoolKey, V4Planner } from "@uniswap/v4-sdk";
import type { ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type GetContractEventsReturnType,
  type Hex,
  maxUint256,
  maxUint48,
  type ValueOf,
  zeroAddress,
} from "viem";
import { getContractEvents, multicall } from "viem/actions";

import { permit2Abi } from "../abis/permit2";
import {
  uniswapUniversalRouterAbi,
  uniswapV4PoolManagerAbi,
  uniswapV4StateViewAbi,
} from "../abis/uniswapV4";
import type { LiquidityVenue, LiquidityVenueClient } from "../liquidityVenue";
import { createLogger, serializeError } from "../logger";
import { readContractWithRpcStats } from "../rpcActions";
import type { ToConvert } from "../types";

const logger = createLogger({ component: "uniswap-v4-venue" });

type InitializeEvent = Awaited<
  GetContractEventsReturnType<typeof uniswapV4PoolManagerAbi, "Initialize", true>
>[number];
type InitializePool = InitializeEvent["args"];
interface PoolCacheEntry {
  currency0: Address;
  currency1: Address;
  events: InitializeEvent[];
  lastUpdate: number;
}

export class UniswapV4Venue implements LiquidityVenue {
  kind = "swap" as const;
  private readonly refreshIntervalMs = 15 * 60 * 1000;
  private poolCreationEventsCache: Record<Hex, PoolCacheEntry> = {};
  private backgroundSyncTimer: ReturnType<typeof setInterval> | undefined;
  private chainId: number | undefined;

  init(client: LiquidityVenueClient) {
    this.chainId = client.chain.id;
  }

  startBackgroundSync(client: LiquidityVenueClient) {
    this.chainId = client.chain.id;
    if (this.backgroundSyncTimer !== undefined || DEPLOYMENTS[client.chain.id] === undefined) {
      return;
    }

    this.backgroundSyncTimer = setInterval(() => {
      void this.syncPools(client).catch(() => undefined);
    }, this.refreshIntervalMs);
  }

  stopBackgroundSync() {
    if (this.backgroundSyncTimer !== undefined) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = undefined;
    }
  }

  registerTokenPair(src: Address, dst: Address) {
    const { currency0, currency1 } = this.normalizePair(src, dst);
    const pairKey = this.poolKey(currency0, currency1);

    this.poolCreationEventsCache[pairKey] ??= {
      currency0,
      currency1,
      events: [],
      lastUpdate: 0,
    };
  }

  supportsRoute(
    encoder: ExecutorEncoder,
    _src: Address,
    _dst: Address,
  ): Promise<boolean> | boolean {
    this.chainId ??= encoder.client.chain.id;
    return DEPLOYMENTS[encoder.client.chain.id] !== undefined;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src: rawSrc, dst: rawDst, srcAmount } = toConvert;

    const deployments = DEPLOYMENTS[encoder.client.chain.id];
    if (!deployments) return toConvert;
    const { PoolManager, StateView, UniversalRouter, Native } = deployments;

    // Uniswap v4 operates on ETH natively
    const shouldUnwrap = rawSrc === Native.address;
    const shouldWrap = rawDst === Native.address;
    const src = shouldUnwrap ? zeroAddress : rawSrc;
    const dst = shouldWrap ? zeroAddress : rawDst;

    const { currency0, currency1, pools } = await this.fetchPools(encoder, PoolManager, src, dst);
    if (pools.length === 0) return toConvert;

    let liquidities: (
      | {
          error: Error;
          result?: undefined;
          status: "failure";
        }
      | {
          error?: undefined;
          result: bigint;
          status: "success";
        }
    )[] = [];

    try {
      liquidities = await multicall(encoder.client, {
        contracts: pools.map((pool) => ({
          ...StateView,
          abi: uniswapV4StateViewAbi,
          functionName: "getLiquidity" as const,
          args: [pool.id],
        })),
        allowFailure: true,
        batchSize: 2 ** 16,
      });
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching pools liquidities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let bestPool = pools[0]!;
    let bestLiquidity = 0n;
    for (let i = 0; i < pools.length; i += 1) {
      const liquidity = liquidities[i];
      if (!liquidity || liquidity.status === "failure") continue;
      if (liquidity.result > bestLiquidity) {
        bestPool = pools[i]!;
        bestLiquidity = liquidity.result;
      }
    }

    const bestPoolKey: PoolKey = {
      currency0,
      currency1,
      fee: bestPool.fee,
      tickSpacing: bestPool.tickSpacing,
      hooks: bestPool.hooks,
    };

    const v4Planner = new V4Planner();
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
      {
        poolKey: bestPoolKey,
        zeroForOne: currency0 === src,
        amountIn: srcAmount,
        amountOutMinimum: 0n,
        hookData: "0x",
      },
    ]);
    v4Planner.addAction(Actions.SETTLE_ALL, [src, maxUint256]);
    v4Planner.addAction(Actions.TAKE_ALL, [dst, 0n]);

    const routePlanner = new RoutePlanner();
    if (shouldUnwrap) {
      routePlanner.addCommand(CommandType.PERMIT2_TRANSFER_FROM, [
        Native.address,
        UniversalRouter.address,
        srcAmount,
      ]);
      routePlanner.addCommand(CommandType.UNWRAP_WETH, [UniversalRouter.address, 0], false);
    }
    routePlanner.addCommand(CommandType.V4_SWAP, [v4Planner.finalize()], false);

    try {
      const permit2Allowance = (await readContractWithRpcStats(
        encoder.client,
        "liquidity_routing",
        {
          abi: erc20Abi,
          address: rawSrc,
          functionName: "allowance",
          args: [encoder.address, deployments.Permit2.address],
        },
      )) as bigint;
      if (permit2Allowance < srcAmount) {
        encoder.erc20Approve(rawSrc, deployments.Permit2.address, maxUint256);
      }
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching Permit2 allowance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const deadline = maxUint48;
    encoder.pushCall(
      deployments.Permit2.address,
      0n,
      encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [rawSrc, deployments.UniversalRouter.address, srcAmount, Number(deadline)],
      }),
    );

    encoder.pushCall(
      UniversalRouter.address,
      0n,
      encodeFunctionData({
        abi: uniswapUniversalRouterAbi,
        functionName: "execute",
        args: [routePlanner.commands as Hex, routePlanner.inputs as Hex[], deadline],
      }),
    );

    if (shouldWrap) {
      encoder.transfer(Native.address, maxUint256);
    }

    return { ...toConvert, src: rawDst, srcAmount: 0n };
  }

  private async fetchPools(
    encoder: ExecutorEncoder,
    poolManager: ValueOf<ValueOf<typeof DEPLOYMENTS>>,
    src: Address,
    dst: Address,
  ) {
    const deployments = DEPLOYMENTS[encoder.client.chain.id];
    if (!deployments || poolManager.address !== deployments.PoolManager.address) {
      const { currency0, currency1 } = this.normalizePair(src, dst);
      return { currency0, currency1, pools: [] as InitializePool[] };
    }

    const { currency0, currency1 } = this.normalizePair(src, dst);
    const cacheEntry = this.poolCreationEventsCache[this.poolKey(currency0, currency1)];
    const pools = (cacheEntry?.events ?? [])
      .filter((event) => event.args.hooks === zeroAddress)
      .map((event) => event.args);

    return { currency0, currency1, pools };
  }

  private async syncPools(client: LiquidityVenueClient) {
    const deployments = DEPLOYMENTS[client.chain.id];
    if (!deployments) return;

    const knownPairs = Object.entries(this.poolCreationEventsCache);
    if (knownPairs.length === 0) return;

    let refreshedPairs = 0;
    let failedPairs = 0;

    await Promise.all(
      knownPairs.map(async ([pairKey, cacheEntry]) => {
        try {
          const poolCreationEvents = await getContractEvents(client, {
            ...deployments.PoolManager,
            abi: uniswapV4PoolManagerAbi,
            eventName: "Initialize",
            args: { currency0: cacheEntry.currency0, currency1: cacheEntry.currency1 },
            strict: true,
          });

          const previousPoolCount = cacheEntry.events.filter(
            (event) => event.args.hooks === zeroAddress,
          ).length;
          const nextPoolCount = poolCreationEvents.filter(
            (event) => event.args.hooks === zeroAddress,
          ).length;

          this.poolCreationEventsCache[pairKey as Hex] = {
            currency0: cacheEntry.currency0,
            currency1: cacheEntry.currency1,
            events: poolCreationEvents,
            lastUpdate: Date.now(),
          };
          refreshedPairs += 1;

          logger.debug(
            {
              chainId: client.chain.id,
              chainName: client.chain.name,
              pairKey,
              previousPoolCount,
              poolCount: nextPoolCount,
              updated: previousPoolCount !== nextPoolCount,
            },
            "refreshed uniswap v4 pair cache",
          );
        } catch (error) {
          failedPairs += 1;
          logger.error(
            {
              chainId: client.chain.id,
              chainName: client.chain.name,
              pairKey,
              error: serializeError(error),
            },
            "failed to refresh uniswap v4 pair cache",
          );
        }
      }),
    );

    logger.info(
      {
        chainId: client.chain.id,
        chainName: client.chain.name,
        knownPairs: knownPairs.length,
        refreshedPairs,
        failedPairs,
      },
      "completed uniswap v4 background refresh",
    );
  }

  private normalizePair(src: Address, dst: Address) {
    const nativeAddress =
      this.chainId !== undefined ? DEPLOYMENTS[this.chainId]?.Native.address : undefined;
    const normalizedSrc = nativeAddress !== undefined && src === nativeAddress ? zeroAddress : src;
    const normalizedDst = nativeAddress !== undefined && dst === nativeAddress ? zeroAddress : dst;

    return BigInt(normalizedSrc) < BigInt(normalizedDst)
      ? { currency0: getAddress(normalizedSrc), currency1: getAddress(normalizedDst) }
      : { currency0: getAddress(normalizedDst), currency1: getAddress(normalizedSrc) };
  }

  private poolKey(currency0: Address, currency1: Address) {
    const [sorted0, sorted1] =
      BigInt(currency0) < BigInt(currency1)
        ? [getAddress(currency0), getAddress(currency1)]
        : [getAddress(currency1), getAddress(currency0)];
    return `${sorted0}${sorted1}` as Hex;
  }
}
