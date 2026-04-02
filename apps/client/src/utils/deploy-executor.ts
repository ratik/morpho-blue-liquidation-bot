import { bytecode, executorAbi } from "executooor-viem";
import { type Address, type WalletClient } from "viem";
import { waitForTransactionReceipt } from "viem/actions";

import { createLogger } from "../logger";

const logger = createLogger({ component: "deploy-executor" });

export const deploy = async (client: WalletClient, account: Address) => {
  const hash = await client.deployContract({
    abi: executorAbi,

    account: client.account!,
    bytecode,
    args: [account],
    chain: client.chain,
  });

  const tx = await waitForTransactionReceipt(client, { hash });

  logger.info(
    { chainId: client.chain?.id, contractAddress: tx.contractAddress },
    `Executor deployed on ${client.chain?.id} at ${tx.contractAddress}`,
  );

  return tx.contractAddress;
};
