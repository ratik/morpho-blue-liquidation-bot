import type { Account, Chain, Client, Transport } from "viem";
import { readContract } from "viem/actions";

const RPC_STATS_STATE_SYMBOL = Symbol.for("morphoBlue.rpcStatsState");

function recordRpcStat(chainId: number, bucket: string, failed: boolean) {
  const globalWithState = globalThis as typeof globalThis & {
    [RPC_STATS_STATE_SYMBOL]?: {
      record: (chainId: number, bucket: string, failed: boolean) => void;
    };
  };

  globalWithState[RPC_STATS_STATE_SYMBOL]?.record(chainId, bucket, failed);
}

export async function readContractWithRpcStats(
  client: Client<Transport, Chain, Account>,
  bucket: "vault_market_fetch" | "misc_runtime_read",
  parameters: Parameters<typeof readContract>[1],
) {
  try {
    const result = await readContract(client, parameters);
    recordRpcStat(client.chain.id, bucket, false);
    return result;
  } catch (error) {
    recordRpcStat(client.chain.id, bucket, true);
    throw error;
  }
}
