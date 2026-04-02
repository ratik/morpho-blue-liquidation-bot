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
import { watchBlocks } from "viem/actions";

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

  // LIQUIDITY VENUES
  const liquidityVenueEntries = config.liquidityVenues.map((liquidityVenueName) => ({
    name: liquidityVenueName,
    venue: createLiquidityVenue(liquidityVenueName),
  }));
  const liquidityVenues = liquidityVenueEntries.map(({ venue }) => venue);

  for (const { name, venue } of liquidityVenueEntries) {
    try {
      await venue.init?.(client);
    } catch (error) {
      logger.error(
        { venue: name, error: serializeError(error), logTag },
        `${logTag}failed to initialize liquidity venue`,
      );
    }
  }

  for (const { name, venue } of liquidityVenueEntries) {
    try {
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

  const blockInterval = config.blockInterval ?? 1;
  let count = 0;

  const startWatching = () => {
    watchBlocks(client, {
      onBlock: () => {
        if (count % blockInterval === 0) {
          bot.run().catch((e: unknown) => {
            logger.error(
              { error: serializeError(e), logTag },
              `${logTag}uncaught error in bot.run()`,
            );
          });
        }
        count++;
      },
      onError: (error) => {
        const retryDelay = config.watchBlocksRetryDelayMs ?? 5_000;
        logger.error(
          { error: serializeError(error), retryDelay, logTag },
          `${logTag}watchBlocks error, restarting watcher`,
        );
        setTimeout(startWatching, retryDelay);
      },
    });
  };

  startWatching();
};
