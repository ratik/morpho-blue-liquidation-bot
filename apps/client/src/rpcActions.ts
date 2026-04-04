import type { Account, Chain, Client, Transport } from "viem";
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  writeContract,
} from "viem/actions";

import { type RpcStatsBucket, recordRpcStat } from "./rpcStats";

type RpcClient = Client<Transport, Chain, Account>;

function recordRpcStatIfPossible(client: RpcClient, bucket: RpcStatsBucket, failed: boolean) {
  const chainId = client.chain?.id;
  if (chainId !== undefined) {
    recordRpcStat(chainId, bucket, failed);
  }
}

export async function readContractWithRpcStats(
  client: RpcClient,
  bucket: RpcStatsBucket,
  parameters: Parameters<typeof readContract>[1],
) {
  try {
    const result = await readContract(client, parameters);
    recordRpcStatIfPossible(client, bucket, false);
    return result;
  } catch (error) {
    recordRpcStatIfPossible(client, bucket, true);
    throw error;
  }
}

export async function simulateCallsWithRpcStats(
  client: RpcClient,
  bucket: RpcStatsBucket,
  parameters: Parameters<typeof simulateCalls>[1],
) {
  try {
    const result = await simulateCalls(client, parameters);
    recordRpcStatIfPossible(client, bucket, false);
    return result;
  } catch (error) {
    recordRpcStatIfPossible(client, bucket, true);
    throw error;
  }
}

export async function getGasPriceWithRpcStats(client: RpcClient, bucket: RpcStatsBucket) {
  try {
    const result = await getGasPrice(client);
    recordRpcStatIfPossible(client, bucket, false);
    return result;
  } catch (error) {
    recordRpcStatIfPossible(client, bucket, true);
    throw error;
  }
}

export async function getBlockNumberWithRpcStats(client: RpcClient, bucket: RpcStatsBucket) {
  try {
    const result = await getBlockNumber(client);
    recordRpcStatIfPossible(client, bucket, false);
    return result;
  } catch (error) {
    recordRpcStatIfPossible(client, bucket, true);
    throw error;
  }
}

export async function writeContractWithRpcStats(
  client: RpcClient,
  bucket: RpcStatsBucket,
  parameters: Parameters<typeof writeContract>[1],
) {
  try {
    const result = await writeContract(client, parameters);
    recordRpcStatIfPossible(client, bucket, false);
    return result;
  } catch (error) {
    recordRpcStatIfPossible(client, bucket, true);
    throw error;
  }
}
