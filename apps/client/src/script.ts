import {
  chainConfigs,
  chainConfig,
  type DataProviderName,
} from "@morpho-blue-liquidation-bot/config";
import {
  createDataProviders,
  type DataProvider,
} from "@morpho-blue-liquidation-bot/data-providers";

import { startHealthServer } from "./health";
import { createLogger, serializeError } from "./logger";

import { launchBot } from ".";

const logger = createLogger({ component: "client-script" });

process.on("unhandledRejection", (reason) => {
  logger.error({ reason: serializeError(reason) }, "Unhandled rejection");
});

process.on("uncaughtException", (error) => {
  logger.error({ error: serializeError(error) }, "Uncaught exception");
});

async function run() {
  const configs = Object.keys(chainConfigs)
    .map((config) => {
      try {
        return chainConfig(Number(config));
      } catch {
        return undefined;
      }
    })
    .filter((config) => config !== undefined);

  // Group chains by data provider name
  const chainsByProvider = new Map<DataProviderName, number[]>();
  for (const config of configs) {
    const existing = chainsByProvider.get(config.dataProvider) ?? [];
    existing.push(config.chainId);
    chainsByProvider.set(config.dataProvider, existing);
  }

  // Create data providers (one per provider type, shared across chains)
  const providersByChain = new Map<number, DataProvider>();
  for (const [providerName, chainIds] of chainsByProvider) {
    const providers = await createDataProviders(providerName, chainIds);
    for (const [chainId, provider] of providers) {
      providersByChain.set(chainId, provider);
    }
  }

  try {
    await startHealthServer();
  } catch (err) {
    logger.error({ error: serializeError(err) }, "Failed to start health server");
  }

  for (const config of configs) {
    const dataProvider = providersByChain.get(config.chainId);
    if (!dataProvider) {
      logger.error({ chainId: config.chainId }, "No data provider for chain, skipping");
      continue;
    }
    try {
      await launchBot(config, dataProvider);
    } catch (err) {
      logger.error(
        { chainId: config.chainId, error: serializeError(err) },
        "Failed to launch bot for chain",
      );
    }
  }
}

void run();
