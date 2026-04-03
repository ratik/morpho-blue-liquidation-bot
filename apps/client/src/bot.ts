import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  AccrualPosition,
  ChainAddresses,
  getChainAddresses,
  type IMarketParams,
  MarketUtils,
  PreLiquidationPosition,
} from "@morpho-org/blue-sdk";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatUnits,
  getAddress,
  LocalAccount,
  maxUint256,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  writeContract,
} from "viem/actions";

import { morphoBlueAbi } from "./abis/morpho/morphoBlue";
import { createLogger, type AppLogger, serializeError } from "./logger";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { Flashbots } from "./utils/flashbots.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";

export interface LiquidationBotInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  simulationClient: WalletClient<Transport, Chain, Account>;
  wNative: Address;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  executorAddress: Address;
  treasuryAddress: Address;
  dataProvider: DataProvider;
  liquidityVenues: LiquidityVenue[];
  alwaysRealizeBadDebt: boolean;
  pricers?: Pricer[];
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  flashbotAccount?: LocalAccount;
}

export class LiquidationBot {
  private logger: AppLogger;
  private logTag: string;
  private chainId: number;
  private client: WalletClient<Transport, Chain, Account>;
  private simulationClient: WalletClient<Transport, Chain, Account>;
  private chainAddresses: ChainAddresses;
  private wNative: Address;
  private vaultWhitelist: Address[] | "morpho-api";
  private additionalMarketsWhitelist: Hex[];
  private executorAddress: Address;
  private treasuryAddress: Address;
  private dataProvider: DataProvider;
  private liquidityVenues: LiquidityVenue[];
  private pricers?: Pricer[];
  private positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  private marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  private flashbotAccount?: LocalAccount;
  private coveredMarkets: Hex[];
  private alwaysRealizeBadDebt: boolean;
  private registeredPricedAssets: Set<Address>;
  private priceCache: Map<Address, { price: number; updatedAt: number }>;
  private decimalsCache: Map<Address, number>;

  constructor(inputs: LiquidationBotInputs) {
    this.logger = createLogger({
      component: "liquidation-bot",
      chainId: inputs.chainId,
    });
    this.logTag = inputs.logTag;
    this.chainId = inputs.chainId;
    this.client = inputs.client;
    this.simulationClient = inputs.simulationClient;
    this.chainAddresses = getChainAddresses(inputs.chainId);
    this.wNative = inputs.wNative;
    this.vaultWhitelist = inputs.vaultWhitelist;
    this.additionalMarketsWhitelist = inputs.additionalMarketsWhitelist;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.dataProvider = inputs.dataProvider;
    this.liquidityVenues = inputs.liquidityVenues;
    this.pricers = inputs.pricers;
    this.positionLiquidationCooldownMechanism = inputs.positionLiquidationCooldownMechanism;
    this.marketsFetchingCooldownMechanism = inputs.marketsFetchingCooldownMechanism;
    this.flashbotAccount = inputs.flashbotAccount;
    this.coveredMarkets = [];
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt;
    this.registeredPricedAssets = new Set();
    this.priceCache = new Map();
    this.decimalsCache = new Map([[this.wNative, 18]]);
  }

  async run() {
    await this.fetchMarkets();

    const { liquidatablePositions, preLiquidatablePositions } =
      await this.dataProvider.fetchLiquidatablePositions(this.client, this.coveredMarkets);

    await Promise.all([
      ...liquidatablePositions.map((position) => this.liquidate(position)),
      ...preLiquidatablePositions.map((position) => this.preLiquidate(position)),
    ]);
  }

  async warmupData() {
    this.logger.info({}, `Warming up markets`);
    await this.fetchMarkets();
    this.logger.info({}, `Warming up bot decimals cache`);
    await this.ensureDecimalsCached();
    this.logger.info({}, `Warming up bot price cache`);
    await this.refreshPriceCache();
    this.logger.info({}, `Warming completed`);
  }

  async ensureDecimalsCached() {
    for (const asset of this.registeredPricedAssets) {
      if (this.decimalsCache.has(asset)) continue;

      if (asset === this.wNative) {
        this.decimalsCache.set(asset, 18);
        continue;
      }

      try {
        const decimals = await readContract(this.client, {
          address: asset,
          abi: erc20Abi,
          functionName: "decimals",
        });
        this.decimalsCache.set(asset, decimals);
      } catch (error) {
        this.logger.error(
          { error: serializeError(error), asset },
          `${this.logTag}Failed to warm token decimals`,
        );
      }
    }
  }

  async refreshPriceCache() {
    if (this.pricers === undefined || this.pricers.length === 0) return;

    for (const asset of this.registeredPricedAssets) {
      const prices = (
        await Promise.all(
          this.pricers.map(async (pricer) => {
            try {
              return await pricer.price(this.client, asset);
            } catch (error) {
              this.logger.error(
                { error: serializeError(error), asset },
                `${this.logTag}Failed to fetch price from pricer`,
              );
              return undefined;
            }
          }),
        )
      ).filter((price): price is number => price !== undefined);

      if (prices.length === 0) continue;

      this.priceCache.set(asset, {
        price: this.calculateMedian(prices),
        updatedAt: Date.now(),
      });
    }
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const badDebtPosition = seizableCollateral === position.collateral;

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    if (
      !(await this.convertCollateralToLoan(
        marketParams,
        this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
        encoder,
      ))
    )
      return;

    encoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);

    encoder.morphoBlueLiquidate(
      this.chainAddresses.morpho,
      {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: BigInt(marketParams.lltv),
      },
      position.user,
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const success = await this.handleTx(encoder, calls, marketParams, badDebtPosition);

      if (success)
        this.logger.info(
          {
            user: position.user,
            marketId: MarketUtils.getMarketId(marketParams),
          },
          `${this.logTag}Liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        this.logger.info(
          {
            user: position.user,
            marketId: MarketUtils.getMarketId(marketParams),
          },
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      this.logger.error(
        {
          error: serializeError(error),
          user: position.user,
          marketId: MarketUtils.getMarketId(marketParams),
        },
        `${this.logTag}Failed to liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
      );
    }
  }

  private async preLiquidate(position: PreLiquidationPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = this.decreaseSeizableCollateral(
      position.seizableCollateral ?? 0n,
      false,
    );

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    if (!(await this.convertCollateralToLoan(marketParams, seizableCollateral, encoder))) return;

    encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, maxUint256);

    encoder.preLiquidate(
      position.preLiquidation,
      position.user,
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const success = await this.handleTx(encoder, calls, marketParams, false);

      if (success)
        this.logger.info(
          {
            user: position.user,
            marketId: MarketUtils.getMarketId(marketParams),
          },
          `${this.logTag}Pre-liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        this.logger.info(
          {
            user: position.user,
            marketId: MarketUtils.getMarketId(marketParams),
          },
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      this.logger.error(
        {
          error: serializeError(error),
          user: position.user,
          marketId: MarketUtils.getMarketId(marketParams),
        },
        `${this.logTag}Failed to pre-liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
      );
    }
  }

  private async handleTx(
    encoder: LiquidationEncoder,
    calls: Hex[],
    marketParams: IMarketParams,
    badDebtPosition: boolean,
  ) {
    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    const [{ results }, gasPrice] = await Promise.all([
      simulateCalls(this.simulationClient, {
        account: this.client.account.address,
        calls: [
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
          { to: encoder.address, ...functionData },
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
        ],
      }),
      getGasPrice(this.client),
    ]);

    if (results[1].status !== "success") {
      this.logger.error(
        {
          simulationError: results[1].error,
          simulationRpcSource: this.simulationClient === this.client ? "main" : "dedicated",
          callCount: calls.length,
          calls,
          marketId: MarketUtils.getMarketId(marketParams),
          marketParams,
          badDebtPosition,
        },
        `${this.logTag}Transaction failed in simulation`,
      );
      return;
    }

    if (
      !(await this.checkProfit(
        marketParams.loanToken,
        {
          beforeTx: results[0].result,
          afterTx: results[2].result,
        },
        {
          used: results[1].gasUsed,
          price: gasPrice,
        },
        badDebtPosition,
      ))
    )
      return false;

    // TX EXECUTION

    if (this.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: this.client,
        },
      ]);

      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(this.client)) + 1n,
        this.flashbotAccount,
      );
      return true;
    } else {
      await writeContract(this.client, { address: encoder.address, ...functionData });
    }

    return true;
  }

  private async convertCollateralToLoan(
    marketParams: IMarketParams,
    seizableCollateral: bigint,
    encoder: LiquidationEncoder,
  ) {
    let toConvert = {
      src: getAddress(marketParams.collateralToken),
      dst: getAddress(marketParams.loanToken),
      srcAmount: seizableCollateral,
    };

    toConvert = await this.applyTransformVenues(encoder, toConvert);
    if (toConvert.src === toConvert.dst) return true;

    toConvert = await this.applySwapVenues(encoder, toConvert);
    if (toConvert.src === toConvert.dst) return true;

    return false;
  }

  private async applyTransformVenues(
    encoder: LiquidationEncoder,
    initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
  ) {
    let toConvert = initialToConvert;
    let iteration = 0;

    while (toConvert.src !== toConvert.dst && iteration < this.liquidityVenues.length) {
      let transformed = false;

      for (const venue of this.liquidityVenues) {
        if (venue.kind !== "transform") continue;
        try {
          if (!(await venue.supportsRoute(encoder, toConvert.src, toConvert.dst))) continue;

          const nextToConvert = await venue.convert(encoder, toConvert);
          if (nextToConvert.src === toConvert.src) continue;

          toConvert = nextToConvert;
          transformed = true;
          break;
        } catch (error) {
          this.logger.error(
            {
              error: serializeError(error),
              src: toConvert.src,
              dst: toConvert.dst,
              venueKind: venue.kind,
            },
            `${this.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`,
          );
        }
      }

      if (!transformed) break;
      iteration++;
    }

    return toConvert;
  }

  private async applySwapVenues(
    encoder: LiquidationEncoder,
    initialToConvert: { src: Address; dst: Address; srcAmount: bigint },
  ) {
    let toConvert = initialToConvert;

    for (const venue of this.liquidityVenues) {
      if (venue.kind !== "swap") continue;
      try {
        if (!(await venue.supportsRoute(encoder, toConvert.src, toConvert.dst))) continue;

        toConvert = await venue.convert(encoder, toConvert);
        if (toConvert.src === toConvert.dst) return toConvert;
      } catch (error) {
        this.logger.error(
          {
            error: serializeError(error),
            src: toConvert.src,
            dst: toConvert.dst,
            venueKind: venue.kind,
          },
          `${this.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`,
        );
      }
    }

    return toConvert;
  }

  private async price(asset: Address, amount: bigint, _pricers: Pricer[]) {
    const price = this.priceCache.get(asset)?.price;

    if (price === undefined) return undefined;

    const decimals = this.decimalsCache.get(asset);
    if (decimals === undefined) return undefined;

    return parseFloat(formatUnits(amount, decimals)) * price;
  }

  private async checkProfit(
    loanAsset: Address,
    loanAssetBalance: {
      beforeTx: bigint | undefined;
      afterTx: bigint | undefined;
    },
    gas: {
      used: bigint;
      price: bigint;
    },
    badDebtPosition: boolean,
  ) {
    if (this.alwaysRealizeBadDebt && badDebtPosition) return true;
    if (this.pricers === undefined || this.pricers.length === 0) return true;

    if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
      return false;

    const loanAssetProfit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx;

    if (loanAssetProfit <= 0n) return false;

    const [loanAssetProfitUsd, gasUsedUsd] = await Promise.all([
      this.price(loanAsset, loanAssetProfit, this.pricers),
      this.price(this.wNative, gas.used * gas.price, this.pricers),
    ]);

    if (loanAssetProfitUsd === undefined || gasUsedUsd === undefined) return false;

    const profitUsd = loanAssetProfitUsd - gasUsedUsd;

    return profitUsd > 0;
  }

  private decreaseSeizableCollateral(seizableCollateral: bigint, badDebtPosition: boolean) {
    if (badDebtPosition) return seizableCollateral;

    const liquidationBufferBps =
      chainConfigs[this.chainId]?.options.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;

    return wMulDown(seizableCollateral, WAD - parseUnits(liquidationBufferBps.toString(), 14));
  }

  private checkCooldown(marketId: Hex, account: Address) {
    if (
      this.positionLiquidationCooldownMechanism !== undefined &&
      !this.positionLiquidationCooldownMechanism.isPositionReady(marketId, account)
    ) {
      return false;
    }
    return true;
  }

  private async fetchMarkets() {
    if (!this.marketsFetchingCooldownMechanism.isFetchingReady()) return;

    if (this.vaultWhitelist === "morpho-api")
      this.vaultWhitelist = await fetchWhitelistedVaults(this.chainId);

    const vaultWhitelist = this.vaultWhitelist;
    this.logger.info(
      { vaultWhitelist, additionalMarketsWhitelist: this.additionalMarketsWhitelist },
      `${this.logTag}Watching markets in the following vaults`,
    );

    const whitelistedMarketsFromVaults = await this.dataProvider.fetchMarkets(
      this.client,
      vaultWhitelist,
    );

    this.coveredMarkets = [...whitelistedMarketsFromVaults, ...this.additionalMarketsWhitelist];
    await this.seedMarketDerivedCaches();
  }

  private async seedMarketDerivedCaches() {
    const pairAwareVenues = this.liquidityVenues.filter(
      (
        venue,
      ): venue is typeof venue & { registerTokenPair: (src: Address, dst: Address) => void } =>
        venue.registerTokenPair !== undefined,
    );
    if (
      (pairAwareVenues.length === 0 && this.pricers === undefined) ||
      this.coveredMarkets.length === 0
    )
      return;

    const uniqueMarketIds = [...new Set(this.coveredMarkets)];
    const results = await Promise.allSettled(
      uniqueMarketIds.map((marketId) =>
        readContract(this.client, {
          address: this.chainAddresses.morpho,
          abi: morphoBlueAbi,
          functionName: "idToMarketParams",
          args: [marketId],
        }),
      ),
    );

    const pairKeys = new Set<string>();
    const assetSet = new Set<Address>(this.pricers !== undefined ? [this.wNative] : []);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(
          { error: serializeError(result.reason) },
          `${this.logTag}Failed to fetch market params while seeding market-derived caches`,
        );
        continue;
      }

      const [loanToken, collateralToken] = result.value;
      pairKeys.add(`${collateralToken}:${loanToken}`);
      assetSet.add(loanToken);
      assetSet.add(collateralToken);
    }

    for (const pairKey of pairKeys) {
      const [collateralToken, loanToken] = pairKey.split(":") as [Address, Address];
      for (const venue of pairAwareVenues) {
        venue.registerTokenPair(collateralToken, loanToken);
      }
    }

    this.registeredPricedAssets = assetSet;
    await this.ensureDecimalsCached();

    if (pairAwareVenues.length > 0) {
      this.logger.info(
        { seededPairs: pairKeys.size, marketCount: uniqueMarketIds.length },
        `${this.logTag}Seeded liquidity venue pairs from covered markets`,
      );
    }

    if (this.pricers !== undefined) {
      this.logger.info(
        { seededAssets: assetSet.size, marketCount: uniqueMarketIds.length },
        `${this.logTag}Seeded bot price cache assets from covered markets`,
      );
    }
  }

  private calculateMedian(prices: number[]) {
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const middle = Math.floor(sortedPrices.length / 2);

    if (sortedPrices.length % 2 === 1) {
      return sortedPrices[middle];
    }

    const left = sortedPrices[middle - 1]!;
    const right = sortedPrices[middle]!;
    return (left + right) / 2;
  }
}
