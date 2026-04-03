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
  private registeredAssets = new Set<Address>();

  async price(client: Client<Transport, Chain, Account>, asset: Address) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.supportedChains.includes(client.chain.id)) return;

    try {
      await this.refreshAssets(client, [asset]);
      return this.getCachedPrice(client, asset);
    } catch (error) {
      logger.error(
        { error: serializeError(error), asset, chainId: client.chain.id },
        "Error fetching Morpho API price",
      );
      return this.getCachedPrice(client, asset);
    }
  }

  registerAsset(asset: Address) {
    this.registeredAssets.add(asset);
  }

  getCachedPrice(client: Client<Transport, Chain, Account>, asset: Address) {
    return this.getCachedEntry(client.chain.id, asset)?.price;
  }

  async refreshRegisteredAssets(client: Client<Transport, Chain, Account>) {
    if (this.registeredAssets.size === 0) return;

    try {
      await this.refreshAssets(client, [...this.registeredAssets]);
    } catch (error) {
      logger.error(
        {
          error: serializeError(error),
          chainId: client.chain.id,
          assetCount: this.registeredAssets.size,
        },
        "Error refreshing Morpho API registered assets",
      );
    }
  }

  private async refreshAssets(client: Client<Transport, Chain, Account>, assets: Address[]) {
    if (assets.length === 0) return;

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.supportedChains.includes(client.chain.id)) return;

    const response = await fetch(this.API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: this.query(client.chain.id, assets) }),
    });

    const data = (await response.json()) as {
      data: { assets: { items: { address: Address; priceUsd: number }[] } };
    };

    const items = data.data.assets.items;
    const priceByAddress = new Map(items.map((item) => [item.address, item.priceUsd]));
    const fetchTimestamp = Date.now();

    for (const asset of assets) {
      this.priceCache.set(`${client.chain.id}:${asset}`, {
        price: priceByAddress.get(asset),
        fetchTimestamp,
      });
    }
  }

  private getCachedEntry(chainId: number, asset: Address) {
    return this.priceCache.get(`${chainId}:${asset}`);
  }

  private query(chainId: number, assets: Address[]) {
    const addresses = assets.map((asset) => `"${asset}"`).join(", ");

    return `
    query {
        assets(where: { address_in: [${addresses}], chainId_in: [${chainId}]} ) {
            items {
                address
                priceUsd
            }
        }
    }
    `;
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
}
