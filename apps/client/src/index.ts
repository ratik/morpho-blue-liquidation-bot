import {
  MARKETS_FETCHING_COOLDOWN_PERIOD,
  POSITION_LIQUIDATION_COOLDOWN_ENABLED,
  POSITION_LIQUIDATION_COOLDOWN_PERIOD,
  ALWAYS_REALIZE_BAD_DEBT,
  type ChainConfig,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { createLogger, serializeError } from "./logger";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms";

export const launchBot = async (config: ChainConfig, dataProvider: DataProvider) => {
  const logTag = `[${config.chain.name} client]: `;
  const logger = createLogger({
    component: "client",
    chainId: config.chain.id,
    chainName: config.chain.name,
  });
  logger.info({ logTag }, `${logTag}Starting up`);

  const client = createWalletClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });
  const simulationRpcUrl = config.simulationRpcUrl ?? config.rpcUrl;
  const simulationClient = createWalletClient({
    chain: config.chain,
    transport: http(simulationRpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });

  logger.debug({ logTag }, `${logTag}Wallet client created with address ${client.account.address}`);
  logger.info(
    {
      logTag,
      simulationRpcSource: config.simulationRpcUrl ? "dedicated" : "main",
      simulationRpcUrl,
    },
    `${logTag}Simulation RPC configured`,
  );

  // LIQUIDITY VENUES
  const liquidityVenueEntries = config.liquidityVenues.map((liquidityVenueName) => ({
    name: liquidityVenueName,
    venue: createLiquidityVenue(liquidityVenueName),
  }));
  const liquidityVenues = liquidityVenueEntries.map(({ venue }) => venue);

  for (const { name, venue } of liquidityVenueEntries) {
    try {
      logger.debug({ venue: name, logTag }, `${logTag}>>initializing liquidity venue`);
      await venue.init?.(client);
      logger.debug({ venue: name, logTag }, `${logTag}<<initialized liquidity venue`);
    } catch (error) {
      logger.error(
        { venue: name, error: serializeError(error), logTag },
        `${logTag}failed to initialize liquidity venue`,
      );
    }
  }

  for (const { name, venue } of liquidityVenueEntries) {
    try {
      logger.debug({ venue: name, logTag }, `${logTag}starting liquidity venue background sync`);
      venue.startBackgroundSync?.(client);
    } catch (error) {
      logger.error(
        { venue: name, error: serializeError(error), logTag },
        `${logTag}failed to start liquidity venue background sync`,
      );
    }
  }

  // PRICERS
  const pricers = config.pricers
    ? config.pricers.map((pricerName) => createPricer(pricerName))
    : undefined;

  // FlASHBOTS

  let flashbotAccount = undefined;
  if (config.useFlashbots) {
    const flashbotsPrivateKey = process.env.FLASHBOTS_PRIVATE_KEY;

    if (flashbotsPrivateKey === undefined) {
      throw new Error(`${logTag} FLASHBOTS_PRIVATE_KEY is not set`);
    }

    flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY as Hex);
  }

  let positionLiquidationCooldownMechanism = undefined;
  if (POSITION_LIQUIDATION_COOLDOWN_ENABLED) {
    positionLiquidationCooldownMechanism = new PositionLiquidationCooldownMechanism(
      POSITION_LIQUIDATION_COOLDOWN_PERIOD,
    );
  }

  const marketsFetchingCooldownMechanism = new MarketsFetchingCooldownMechanism(
    MARKETS_FETCHING_COOLDOWN_PERIOD,
  );

  const inputs: LiquidationBotInputs = {
    logTag,
    chainId: config.chainId,
    client,
    simulationClient,
    wNative: config.wNative,
    vaultWhitelist: config.vaultWhitelist,
    additionalMarketsWhitelist: config.additionalMarketsWhitelist,
    executorAddress: config.executorAddress,
    treasuryAddress: config.treasuryAddress ?? client.account.address,
    dataProvider,
    liquidityVenues,
    pricers,
    marketsFetchingCooldownMechanism,
    positionLiquidationCooldownMechanism,
    flashbotAccount,
    alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
  };

  const bot = new LiquidationBot(inputs);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  await bot.warmupData();

  const PRICE_REFRESH_INTERVAL_MS = 30_000;
  logger.info(
    { logTag, priceRefreshIntervalMs: PRICE_REFRESH_INTERVAL_MS },
    `${logTag}Pricer refresh configured`,
  );

  const refreshPriceCache = async () => {
    try {
      await bot.refreshPriceCache();
    } catch (error) {
      logger.error(
        { error: serializeError(error), logTag },
        `${logTag}failed to refresh bot price cache`,
      );
    }
  };

  const startPriceRefreshLoop = async () => {
    while (true) {
      await sleep(PRICE_REFRESH_INTERVAL_MS);
      await refreshPriceCache();
    }
  };

  void startPriceRefreshLoop();

  const pollingIntervalMs = config.pollingIntervalMs ?? 10_000;
  logger.info({ logTag, pollingIntervalMs }, `${logTag}Polling configured`);

  let isRunning = false;
  let rerunRequested = false;

  const runCycle = async () => {
    if (isRunning) {
      rerunRequested = true;
      logger.info({ logTag }, `${logTag}Polling tick coalesced into queued rerun`);
      return;
    }

    isRunning = true;
    do {
      rerunRequested = false;
      try {
        await bot.run();
      } catch (e: unknown) {
        logger.error({ error: serializeError(e), logTag }, `${logTag}uncaught error in bot.run()`);
      }
    } while (rerunRequested);

    isRunning = false;
  };

  const startPolling = async () => {
    await runCycle();

    while (true) {
      await sleep(pollingIntervalMs);
      await runCycle();
    }
  };

  void startPolling();
};
