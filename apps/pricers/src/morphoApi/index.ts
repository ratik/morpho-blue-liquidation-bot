import type { Account, Address, Chain, Client, Transport } from "viem";

import { createLogger, serializeError } from "../logger";
import type { Pricer } from "../pricer";

const logger = createLogger({ component: "morpho-api-pricer" });

type CoinKey = `${number}:${Address}`;

interface CachedPrice {
  price: number | undefined;
  fetchTimestamp: number;
}

export class MorphoApi implements Pricer {
  private readonly API_URL = "https://blue-api.morpho.org/graphql";
  private readonly CACHE_TIMEOUT_MS = 30_000;
  private supportedChains: number[] = [];
  private initialized = false;
  private priceCache = new Map<CoinKey, CachedPrice>();

  async price(client: Client<Transport, Chain, Account>, asset: Address) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.supportedChains.includes(client.chain.id)) return;

    const coinKey: CoinKey = `${client.chain.id}:${asset}`;
    const cachedPrice = this.priceCache.get(coinKey);
    if (cachedPrice && Date.now() - cachedPrice.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
      return cachedPrice.price;
    }

    try {
      const response = await fetch(this.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: this.query(client.chain.id, asset) }),
      });

      const data = (await response.json()) as {
        data: { assets: { items: { address: Address; priceUsd: number }[] } };
      };

      const items = data.data.assets.items;

      const priceUsd = items.find((item) => item.address === asset)?.priceUsd ?? undefined;
      this.priceCache.set(coinKey, {
        price: priceUsd,
        fetchTimestamp: Date.now(),
      });

      return priceUsd;
    } catch (error) {
      logger.error(
        { error: serializeError(error), asset, chainId: client.chain.id },
        "Error fetching Morpho API price",
      );
      if (cachedPrice && Date.now() - cachedPrice.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
        return cachedPrice.price;
      }
      return undefined;
    }
  }

  private async initialize() {
    const initilizationQuery = `
      query {
        chains{
            id
        }
      }
      `;

    try {
      const response = await fetch(this.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: initilizationQuery }),
      });

      const data = (await response.json()) as { data: { chains: { id: number }[] } };
      this.supportedChains = data.data.chains.map((chain) => chain.id);
      this.initialized = true;
    } catch (error) {
      logger.error({ error: serializeError(error) }, "Error initializing Morpho API pricer");
    }
  }

  private query(chainId: number, asset: Address) {
    return `
    query {
        assets(where: { address_in: ["${asset}"], chainId_in: [${chainId}]} ) {
            items {
                address
                priceUsd
            }
        }
    }
    `;
  }
}
