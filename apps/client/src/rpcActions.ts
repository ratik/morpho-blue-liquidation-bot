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

export async function readContractWithRpcStats(
  client: RpcClient,
  bucket: RpcStatsBucket,
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

export async function simulateCallsWithRpcStats(
  client: RpcClient,
  bucket: RpcStatsBucket,
  parameters: Parameters<typeof simulateCalls>[1],
) {
  try {
    const result = await simulateCalls(client, parameters);
    recordRpcStat(client.chain.id, bucket, false);
    return result;
  } catch (error) {
    recordRpcStat(client.chain.id, bucket, true);
    throw error;
  }
}

export async function getGasPriceWithRpcStats(client: RpcClient, bucket: RpcStatsBucket) {
  try {
    const result = await getGasPrice(client);
    recordRpcStat(client.chain.id, bucket, false);
    return result;
  } catch (error) {
    recordRpcStat(client.chain.id, bucket, true);
    throw error;
  }
}

export async function getBlockNumberWithRpcStats(client: RpcClient, bucket: RpcStatsBucket) {
  try {
    const result = await getBlockNumber(client);
    recordRpcStat(client.chain.id, bucket, false);
    return result;
  } catch (error) {
    recordRpcStat(client.chain.id, bucket, true);
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
    recordRpcStat(client.chain.id, bucket, false);
    return result;
  } catch (error) {
    recordRpcStat(client.chain.id, bucket, true);
    throw error;
  }
}
