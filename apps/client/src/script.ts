import { chainConfigs, chainConfig } from "@morpho-blue-liquidation-bot/config";
import { createDataProviders } from "@morpho-blue-liquidation-bot/data-providers";

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

  const providersByChain = await createDataProviders(configs.map((config) => config.chainId));

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
