import {
  DENOMINATIONS,
  FEED_REGISTRY_ADDRESS,
  MAPPINGS,
} from "@morpho-blue-liquidation-bot/config";
import {
  formatUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { mainnet } from "viem/chains";

import { feedRegistryAbi } from "../abis/feedRegistry";
import { createLogger, serializeError } from "../logger";
import type { Pricer } from "../pricer";
import { readContractWithRpcStats } from "../rpcActions";

const logger = createLogger({ component: "chainlink-pricer" });

type CoinKey = `${string}:${Address}`;

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
}

export class ChainlinkPricer implements Pricer {
  private readonly CACHE_TIMEOUT_MS = 30_000; // 30 seconds

  private priceCache = new Map<CoinKey, CachedPrice>();

  async price(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<number | undefined> {
    asset = MAPPINGS[asset] ?? asset;

    // Feed Registry is only available on Ethereum Mainnet
    if (client.chain.id !== mainnet.id) {
      return undefined;
    }

    const coinKey: CoinKey = `${client.chain.name}:${asset}`;
    const cachedPrice = this.priceCache.get(coinKey);

    // Return cached price if available and not expired
    if (cachedPrice && Date.now() - cachedPrice.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
      return cachedPrice.price;
    }

    try {
      // Query price from Feed Registry
      const [roundData, decimals] = await Promise.all([
        readContractWithRpcStats(client, "price_refresh", {
          address: FEED_REGISTRY_ADDRESS,
          abi: feedRegistryAbi,
          functionName: "latestRoundData",
          args: [asset, DENOMINATIONS.USD],
        }),
        readContractWithRpcStats(client, "price_refresh", {
          address: FEED_REGISTRY_ADDRESS,
          abi: feedRegistryAbi,
          functionName: "decimals",
          args: [asset, DENOMINATIONS.USD],
        }),
      ]);

      // Extract price from round data (answer is the price)
      const rawPrice = roundData[1];

      // Ensure price is positive
      if (rawPrice <= 0n) {
        return undefined;
      }

      // Convert to proper decimal representation
      const price = Number(formatUnits(rawPrice, decimals));

      // Cache the result
      this.priceCache.set(coinKey, { price, fetchTimestamp: Date.now() });

      return price;
    } catch (error) {
      logger.error(
        { asset, error: serializeError(error) },
        `Error fetching Chainlink price for ${asset}`,
      );
      return undefined;
    }
  }
}
