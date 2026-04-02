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
import { getBlockNumber, getContractEvents, multicall, readContract } from "viem/actions";

import { permit2Abi } from "../abis/permit2";
import {
  uniswapUniversalRouterAbi,
  uniswapV4PoolManagerAbi,
  uniswapV4StateViewAbi,
} from "../abis/uniswapV4";
import type { LiquidityVenue, LiquidityVenueClient } from "../liquidityVenue";
import { createLogger, serializeError } from "../logger";
import type { ToConvert } from "../types";

const logger = createLogger({ component: "uniswap-v4-venue" });

type InitializeEvent = Awaited<
  GetContractEventsReturnType<typeof uniswapV4PoolManagerAbi, "Initialize", true>
>[number];
type InitializePool = InitializeEvent["args"];

export class UniswapV4Venue implements LiquidityVenue {
  kind = "swap" as const;
  private readonly refreshIntervalMs = 15 * 60 * 1000;
  private readonly logChunkSize = 50_000n;
  private poolsByPair: Record<Hex, InitializePool[]> = {};
  private lastProcessedBlock: bigint | undefined;
  private backgroundSyncTimer: ReturnType<typeof setInterval> | undefined;

  async init(client: LiquidityVenueClient) {
    await this.syncPools(client, "startup");
  }

  startBackgroundSync(client: LiquidityVenueClient) {
    if (this.backgroundSyncTimer !== undefined || DEPLOYMENTS[client.chain.id] === undefined) {
      return;
    }

    this.backgroundSyncTimer = setInterval(() => {
      void this.syncPools(client, "background").catch(() => undefined);
    }, this.refreshIntervalMs);
  }

  stopBackgroundSync() {
    if (this.backgroundSyncTimer !== undefined) {
      clearInterval(this.backgroundSyncTimer);
      this.backgroundSyncTimer = undefined;
    }
  }

  supportsRoute(
    encoder: ExecutorEncoder,
    _src: Address,
    _dst: Address,
  ): Promise<boolean> | boolean {
    if (DEPLOYMENTS[encoder.client.chain.id] === undefined) return false;
    if (this.lastProcessedBlock !== undefined) return true;
    return this.init(encoder.client).then(() => true);
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
        // TODO: could improve this by picking minimum fee tier if there's a set
        // of similarly-sized pools.
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

    // Configure exact swap at the Uniswap v4 Router level
    const v4Planner = new V4Planner();
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
      // See https://github.com/Uniswap/sdks/blob/5a1cbfb55d47625afd40f5f0f5e934ed18dfd5e4/sdks/v4-sdk/src/utils/v4Planner.ts#L70
      {
        poolKey: bestPoolKey,
        zeroForOne: currency0 === src,
        amountIn: srcAmount,
        amountOutMinimum: 0n,
        hookData: "0x",
      },
    ]);
    v4Planner.addAction(Actions.SETTLE_ALL, [src, maxUint256]); // [currency, maxAmount]
    v4Planner.addAction(Actions.TAKE_ALL, [dst, 0n]); // [currency, minAmount]

    // Configure overall actions at the Uniswap Universal Router level
    const routePlanner = new RoutePlanner();
    if (shouldUnwrap) {
      routePlanner.addCommand(CommandType.PERMIT2_TRANSFER_FROM, [
        Native.address,
        UniversalRouter.address,
        srcAmount,
      ]);
      routePlanner.addCommand(CommandType.UNWRAP_WETH, [UniversalRouter.address, 0], false);
    }
    // See https://github.com/Uniswap/sdks/blob/5a1cbfb55d47625afd40f5f0f5e934ed18dfd5e4/sdks/universal-router-sdk/src/utils/routerCommands.ts#L268
    routePlanner.addCommand(CommandType.V4_SWAP, [v4Planner.finalize()], false);

    // Make sure Permit2 can control our tokens
    try {
      const permit2Allowance = await readContract(encoder.client, {
        abi: erc20Abi,
        address: rawSrc,
        functionName: "allowance",
        args: [encoder.address, deployments.Permit2.address],
      });
      if (permit2Allowance < srcAmount) {
        encoder.erc20Approve(rawSrc, deployments.Permit2.address, maxUint256);
      }
    } catch (error) {
      throw new Error(
        `(UniswapV4) Error fetching Permit2 allowance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Tell Permit2 that the UniversalRouter can spend our tokens
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
      // `Executor` contract caps amount at `address(this).balance`, and WETH receive
      // function falls back to a deposit -- this is the only way to wrap max amount
      // since placeholders can't specify msg.value.
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
    if (this.lastProcessedBlock === undefined) {
      await this.init(encoder.client);
    }

    // Each pool's currencies are always sorted numerically.
    const [currency0, currency1] = BigInt(src) < BigInt(dst) ? [src, dst] : [dst, src];

    if (poolManager.address !== DEPLOYMENTS[encoder.client.chain.id]?.PoolManager.address) {
      return { currency0, currency1, pools: [] };
    }

    return {
      currency0,
      currency1,
      pools: this.poolsByPair[this.poolKey(currency0, currency1)] ?? [],
    };
  }

  private async syncPools(client: LiquidityVenueClient, source: "startup" | "background") {
    const deployments = DEPLOYMENTS[client.chain.id];
    if (!deployments) return;

    const latestBlock = await getBlockNumber(client);
    const fromBlock =
      this.lastProcessedBlock === undefined
        ? (deployments.PoolManager.fromBlock ?? 0n)
        : this.lastProcessedBlock + 1n;

    if (fromBlock > latestBlock) {
      this.lastProcessedBlock = latestBlock;
      return;
    }

    try {
      let cursor = fromBlock;
      let newPoolCount = 0;

      while (cursor <= latestBlock) {
        const toBlock =
          cursor + this.logChunkSize - 1n > latestBlock
            ? latestBlock
            : cursor + this.logChunkSize - 1n;

        const events = await getContractEvents(client, {
          ...deployments.PoolManager,
          abi: uniswapV4PoolManagerAbi,
          eventName: "Initialize",
          strict: true,
          fromBlock: cursor,
          toBlock,
        });

        newPoolCount += this.addPools(events);
        cursor = toBlock + 1n;
      }

      this.lastProcessedBlock = latestBlock;

      logger.info(
        {
          chainId: client.chain.id,
          chainName: client.chain.name,
          fromBlock,
          toBlock: latestBlock,
          poolsIndexed: newPoolCount,
          source,
        },
        "refreshed uniswap v4 pool cache",
      );
    } catch (error) {
      logger.error(
        {
          chainId: client.chain.id,
          chainName: client.chain.name,
          fromBlock,
          toBlock: latestBlock,
          source,
          error: serializeError(error),
        },
        "failed to refresh uniswap v4 pool cache",
      );
      throw new Error(
        `(UniswapV4) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private addPools(events: InitializeEvent[]) {
    let added = 0;

    for (const event of events) {
      const pool = event.args;
      if (pool.hooks !== zeroAddress) continue;

      const pairKey = this.poolKey(pool.currency0, pool.currency1);
      const existingPools = this.poolsByPair[pairKey] ?? [];
      if (existingPools.some((existingPool) => existingPool.id === pool.id)) {
        continue;
      }

      existingPools.push(pool);
      this.poolsByPair[pairKey] = existingPools;
      added += 1;
    }

    return added;
  }

  private poolKey(currency0: Address, currency1: Address) {
    const [sorted0, sorted1] =
      BigInt(currency0) < BigInt(currency1)
        ? [getAddress(currency0), getAddress(currency1)]
        : [getAddress(currency1), getAddress(currency0)];
    return `${sorted0}${sorted1}` as Hex;
  }
}
