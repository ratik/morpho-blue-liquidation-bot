import type { AppLogger } from "./logger";

export type RpcStatsBucket =
  | "vault_market_fetch"
  | "market_seed"
  | "decimals_warmup"
  | "price_refresh"
  | "liquidity_routing"
  | "tx_simulation"
  | "gas_price"
  | "block_number"
  | "tx_submit"
  | "misc_runtime_read";

interface RpcStatsState {
  collectors: Map<number, RpcStatsCollector>;
  record: (chainId: number, bucket: RpcStatsBucket, failed: boolean) => void;
}

const RPC_STATS_STATE_SYMBOL = Symbol.for("morphoBlue.rpcStatsState");

function getRpcStatsState() {
  const globalWithState = globalThis as typeof globalThis & {
    [RPC_STATS_STATE_SYMBOL]?: RpcStatsState;
  };

  if (globalWithState[RPC_STATS_STATE_SYMBOL] === undefined) {
    const collectors = new Map<number, RpcStatsCollector>();
    globalWithState[RPC_STATS_STATE_SYMBOL] = {
      collectors,
      record: (chainId, bucket, failed) => {
        collectors.get(chainId)?.record(bucket, failed);
      },
    };
  }

  return globalWithState[RPC_STATS_STATE_SYMBOL];
}

interface BucketStats {
  total: number;
  failed: number;
}

export class RpcStatsCollector {
  private buckets = new Map<RpcStatsBucket, BucketStats>();

  record(bucket: RpcStatsBucket, failed: boolean) {
    const stats = this.buckets.get(bucket) ?? { total: 0, failed: 0 };
    stats.total += 1;
    if (failed) stats.failed += 1;
    this.buckets.set(bucket, stats);
  }

  snapshotAndReset() {
    if (this.buckets.size === 0) return undefined;

    const snapshot = Object.fromEntries(this.buckets.entries()) as Record<
      RpcStatsBucket,
      BucketStats
    >;
    this.buckets = new Map();
    return snapshot;
  }

  hasEntries() {
    return this.buckets.size > 0;
  }
}

export function registerRpcStatsCollector(chainId: number, collector: RpcStatsCollector) {
  getRpcStatsState().collectors.set(chainId, collector);
}

export function recordRpcStat(chainId: number, bucket: RpcStatsBucket, failed = false) {
  getRpcStatsState().record(chainId, bucket, failed);
}

export function startRpcStatsReportingLoop(params: {
  chainId: number;
  chainName: string;
  logger: AppLogger;
  collector: RpcStatsCollector;
  intervalMs?: number;
}) {
  const { chainId, chainName, logger, collector, intervalMs = 60_000 } = params;

  const loop = async () => {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const stats = collector.snapshotAndReset();
      if (stats === undefined) continue;

      logger.info(
        {
          chainId,
          chainName,
          windowSeconds: intervalMs / 1000,
          stats,
        },
        "RPC request stats",
      );
    }
  };

  void loop();
}
