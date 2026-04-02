import type { Account, Address, Chain, Client, Transport } from "viem";

import { createLogger, serializeError } from "../logger";
import type { Pricer } from "../pricer";

const logger = createLogger({ component: "morpho-api-pricer" });

export class MorphoApi implements Pricer {
  private readonly API_URL = "https://blue-api.morpho.org/graphql";
  private supportedChains: number[] = [];
  private initialized = false;

  async price(client: Client<Transport, Chain, Account>, asset: Address) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.supportedChains.includes(client.chain.id)) return;

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

      const priceUsd = items.find((item) => item.address === asset)?.priceUsd ?? null;

      return priceUsd ?? undefined;
    } catch (error) {
      logger.error(
        { error: serializeError(error), asset, chainId: client.chain.id },
        "Error fetching Morpho API price",
      );
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
